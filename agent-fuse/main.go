// cumora-fuse — a FUSE driver that maps the agent's slice of the
// `agent_workspace` table to a real filesystem at the mount point.
//
//	cumora-fuse "$CUMORA_AGENT_RUNTIME_URL" "$CUMORA_AGENT_RUNTIME_TOKEN" /workspace
//
// Instead of connecting to Postgres directly, the FUSE driver issues
// HTTP requests to the cumora server's `/runtime/fs/*` endpoints.
// The server has the DB pool and uses the JWT-pinned agentId on every
// query, so the Pod stays credential-free (only a bearer token, just
// like /runtime/cli).
//
// Why HTTP instead of direct PG:
//   - Managed PG (Cloud SQL / RDS / Azure) doesn't comfortably let
//     hundreds of pods open hundreds of DB connections; centralizing
//     the connection pool on the server side keeps it cloud-portable.
//   - One auth model for the Pod: just the JWT. No per-agent PG
//     roles, no pg_hba, no listen_addresses tweaks.
//   - The Pod's FUSE driver, server, and CLI shim all hit the same
//     `/runtime/*` surface — single attack surface to harden.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path"
	"sync"
	"syscall"
	"time"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
)

// ─── HTTP client wrapper ───────────────────────────────────────────

type ws struct {
	baseURL string
	token   string
	c       *http.Client
}

func newWs(baseURL, token string) *ws {
	return &ws{
		baseURL: baseURL,
		token:   token,
		c: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

func (w *ws) do(method, p string, query url.Values, body any) ([]byte, int, error) {
	u := w.baseURL + p
	if query != nil {
		u += "?" + query.Encode()
	}
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(context.Background(), method, u, rdr)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+w.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := w.c.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	respBody, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, res.StatusCode, err
	}
	return respBody, res.StatusCode, nil
}

type statResp struct {
	Exists bool  `json:"exists"`
	IsDir  bool  `json:"isDir"`
	Size   int64 `json:"size"`
}

func (w *ws) stat(p string) (statResp, syscall.Errno) {
	body, code, err := w.do("GET", "/fs/stat", url.Values{"path": []string{p}}, nil)
	if err != nil {
		log.Printf("[cumora-fuse] stat(%q) network error: %v", p, err)
		return statResp{}, syscall.EIO
	}
	if code != 200 {
		log.Printf("[cumora-fuse] stat(%q) http %d: %s", p, code, truncate(body))
		return statResp{}, syscall.EIO
	}
	var out statResp
	if err := json.Unmarshal(body, &out); err != nil {
		return statResp{}, syscall.EIO
	}
	return out, 0
}

func (w *ws) readFile(p string) ([]byte, syscall.Errno) {
	body, code, err := w.do("GET", "/fs/read", url.Values{"path": []string{p}}, nil)
	if err != nil {
		log.Printf("[cumora-fuse] read(%q) network error: %v", p, err)
		return nil, syscall.EIO
	}
	if code == 404 {
		return nil, syscall.ENOENT
	}
	if code != 200 {
		log.Printf("[cumora-fuse] read(%q) http %d: %s", p, code, truncate(body))
		return nil, syscall.EIO
	}
	var out struct {
		Body string `json:"body"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, syscall.EIO
	}
	return []byte(out.Body), 0
}

func (w *ws) writeFile(p string, content []byte) syscall.Errno {
	_, code, err := w.do("PUT", "/fs/write", nil, map[string]string{
		"path": p,
		"body": string(content),
	})
	if err != nil {
		log.Printf("[cumora-fuse] write(%q) network error: %v", p, err)
		return syscall.EIO
	}
	if code != 200 {
		return syscall.EIO
	}
	return 0
}

func (w *ws) unlink(p string) syscall.Errno {
	_, code, err := w.do("DELETE", "/fs/unlink", url.Values{"path": []string{p}}, nil)
	if err != nil {
		return syscall.EIO
	}
	if code != 200 {
		return syscall.EIO
	}
	return 0
}

type dirent struct {
	Name  string `json:"name"`
	IsDir bool   `json:"isDir"`
}

func (w *ws) listChildren(dir string) ([]dirent, syscall.Errno) {
	body, code, err := w.do("GET", "/fs/list", url.Values{"path": []string{dir}}, nil)
	if err != nil {
		return nil, syscall.EIO
	}
	if code != 200 {
		return nil, syscall.EIO
	}
	var out struct {
		Entries []dirent `json:"entries"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, syscall.EIO
	}
	return out.Entries, 0
}

func truncate(b []byte) string {
	s := string(b)
	if len(s) > 200 {
		return s[:200] + "…"
	}
	return s
}

// ─── inode types ───────────────────────────────────────────────────

type dirNode struct {
	fs.Inode
	w       *ws
	relPath string
}

func (d *dirNode) attr(out *fuse.Attr) {
	out.Mode = fuse.S_IFDIR | 0o755
	out.Mtime = uint64(time.Now().Unix())
	out.Nlink = 2
}

func (d *dirNode) Getattr(ctx context.Context, fh fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	d.attr(&out.Attr)
	return 0
}

func (d *dirNode) Lookup(ctx context.Context, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	child := joinRel(d.relPath, name)
	st, errno := d.w.stat(child)
	if errno != 0 {
		return nil, errno
	}
	if !st.Exists {
		return nil, syscall.ENOENT
	}
	if st.IsDir {
		dn := &dirNode{w: d.w, relPath: child}
		dn.attr(&out.Attr)
		return d.NewInode(ctx, dn, fs.StableAttr{Mode: fuse.S_IFDIR}), 0
	}
	fn := &fileNode{w: d.w, relPath: child, size: st.Size}
	fn.fillAttr(&out.Attr, st.Size)
	return d.NewInode(ctx, fn, fs.StableAttr{Mode: fuse.S_IFREG}), 0
}

// NodeReaddirer signature in hanwen/go-fuse/v2 is just (ctx) — no
// file handle. Adding an extra parameter would silently fail to
// satisfy the interface, and go-fuse would fall back to listing the
// inode's STATIC children (the ones lazily created by Lookup calls),
// not the underlying source of truth. That's the "ls /workspace is
// empty" bug.
func (d *dirNode) Readdir(ctx context.Context) (fs.DirStream, syscall.Errno) {
	entries, errno := d.w.listChildren(d.relPath)
	if errno != 0 {
		return nil, errno
	}
	out := make([]fuse.DirEntry, 0, len(entries))
	for _, e := range entries {
		mode := uint32(fuse.S_IFREG)
		if e.IsDir {
			mode = fuse.S_IFDIR
		}
		out = append(out, fuse.DirEntry{Name: e.Name, Mode: mode})
	}
	return fs.NewListDirStream(out), 0
}

func (d *dirNode) Mkdir(ctx context.Context, name string, mode uint32, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	// Implicit directory — no row to create. Just return a synthetic
	// dirNode; the DB will reflect the dir once a file lands in it.
	child := joinRel(d.relPath, name)
	dn := &dirNode{w: d.w, relPath: child}
	dn.attr(&out.Attr)
	return d.NewInode(ctx, dn, fs.StableAttr{Mode: fuse.S_IFDIR}), 0
}

func (d *dirNode) Create(ctx context.Context, name string, flags uint32, mode uint32, out *fuse.EntryOut) (*fs.Inode, fs.FileHandle, uint32, syscall.Errno) {
	child := joinRel(d.relPath, name)
	// The kernel normally sends CREATE only after Lookup reported ENOENT, so
	// an existing file is rejected by VFS before this callback for O_EXCL.
	// The runtime endpoint is an upsert, however; closing the lookup/create
	// race requires an atomic create-exclusive server operation, not a local
	// stat-then-write sequence.
	if errno := d.w.writeFile(child, nil); errno != 0 {
		return nil, nil, 0, errno
	}
	fn := &fileNode{w: d.w, relPath: child, cachedBody: []byte{}, cachedAt: time.Now(), loaded: true}
	fn.fillAttr(&out.Attr, 0)
	return d.NewInode(ctx, fn, fs.StableAttr{Mode: fuse.S_IFREG}), &fileHandle{f: fn}, 0, 0
}

func (d *dirNode) Unlink(ctx context.Context, name string) syscall.Errno {
	return d.w.unlink(joinRel(d.relPath, name))
}

func (d *dirNode) Rmdir(ctx context.Context, name string) syscall.Errno {
	// Implicit dirs vanish on their own when their last child is
	// unlinked. We refuse if any rows still live under this prefix.
	child := joinRel(d.relPath, name)
	st, errno := d.w.stat(child)
	if errno != 0 {
		return errno
	}
	if st.Exists && st.IsDir {
		return syscall.ENOTEMPTY
	}
	return 0
}

// ─── file node ─────────────────────────────────────────────────────

const fileCacheTTL = 2 * time.Second

type fileNode struct {
	fs.Inode

	w       *ws
	relPath string
	size    int64

	mu         sync.Mutex
	flushMu    sync.Mutex
	cachedBody []byte
	cachedAt   time.Time
	loaded     bool
	dirty      bool
	generation uint64
}

func (f *fileNode) fillAttr(a *fuse.Attr, size int64) {
	a.Mode = fuse.S_IFREG | 0o644
	a.Mtime = uint64(time.Now().Unix())
	a.Nlink = 1
	a.Size = uint64(size)
}

// ensureCurrentLocked hydrates the cache when it is uncached or stale. The
// caller must hold f.mu. Keeping the HTTP read under the same lock as cache
// updates means a partial write cannot race hydration and apply to the wrong
// base. It deliberately does not clone the body; write callers mutate the
// cache while snapshot-returning callers clone it below.
func (f *fileNode) ensureCurrentLocked() syscall.Errno {
	// A dirty cache is authoritative until its snapshot has been uploaded. Its
	// TTL must not cause an in-flight local edit to be replaced by remote data.
	if f.dirty || (f.loaded && time.Since(f.cachedAt) < fileCacheTTL) {
		return 0
	}
	body, errno := f.w.readFile(f.relPath)
	if errno != 0 {
		return errno
	}
	f.cachedBody = body
	f.cachedAt = time.Now()
	f.loaded = true
	return 0
}

func (f *fileNode) loadIfStale() ([]byte, syscall.Errno) {
	f.mu.Lock()
	errno := f.ensureCurrentLocked()
	var body []byte
	if errno == 0 {
		body = bytes.Clone(f.cachedBody)
	}
	f.mu.Unlock()
	return body, errno
}

func (f *fileNode) Getattr(ctx context.Context, fh fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	body, errno := f.loadIfStale()
	if errno != 0 {
		return errno
	}
	f.fillAttr(&out.Attr, int64(len(body)))
	return 0
}

func (f *fileNode) Open(ctx context.Context, flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	return &fileHandle{f: f}, 0, 0
}

func (f *fileNode) Read(ctx context.Context, fh fs.FileHandle, dest []byte, off int64) (fuse.ReadResult, syscall.Errno) {
	body, errno := f.loadIfStale()
	if errno != 0 {
		return nil, errno
	}
	if off < 0 {
		return nil, syscall.EINVAL
	}
	end := off + int64(len(dest))
	if end > int64(len(body)) {
		end = int64(len(body))
	}
	if off >= end {
		return fuse.ReadResultData([]byte{}), 0
	}
	return fuse.ReadResultData(body[off:end]), 0
}

func (f *fileNode) Write(ctx context.Context, fh fs.FileHandle, data []byte, off int64) (uint32, syscall.Errno) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if off < 0 {
		return 0, syscall.EINVAL
	}
	maxInt := int(^uint(0) >> 1)
	if uint64(off) > uint64(maxInt-len(data)) {
		return 0, syscall.EFBIG
	}
	if errno := f.ensureCurrentLocked(); errno != 0 {
		return 0, errno
	}
	need := int(off) + len(data)
	if need > len(f.cachedBody) {
		grown := make([]byte, need)
		copy(grown, f.cachedBody)
		f.cachedBody = grown
	}
	copy(f.cachedBody[off:], data)
	f.dirty = true
	f.generation++
	return uint32(len(data)), 0
}

func (f *fileNode) Flush(ctx context.Context, fh fs.FileHandle) syscall.Errno {
	return f.persist()
}

func (f *fileNode) Fsync(ctx context.Context, fh fs.FileHandle, flags uint32) syscall.Errno {
	return f.persist()
}

func (f *fileNode) Setattr(ctx context.Context, fh fs.FileHandle, in *fuse.SetAttrIn, out *fuse.AttrOut) syscall.Errno {
	f.mu.Lock()
	if errno := f.ensureCurrentLocked(); errno != 0 {
		f.mu.Unlock()
		return errno
	}
	if size, ok := in.GetSize(); ok {
		maxInt := uint64(^uint(0) >> 1)
		if size > maxInt {
			f.mu.Unlock()
			return syscall.EFBIG
		}
		if int(size) < len(f.cachedBody) {
			f.cachedBody = f.cachedBody[:int(size)]
		} else if int(size) > len(f.cachedBody) {
			grown := make([]byte, size)
			copy(grown, f.cachedBody)
			f.cachedBody = grown
		}
		f.dirty = true
		f.generation++
	}
	body := bytes.Clone(f.cachedBody)
	f.mu.Unlock()
	f.fillAttr(&out.Attr, int64(len(body)))
	return 0
}

func (f *fileNode) persist() syscall.Errno {
	// FUSE can issue overlapping Flush/Fsync callbacks. Serialize the remote
	// whole-file writes so an older request cannot complete after a newer one.
	f.flushMu.Lock()
	defer f.flushMu.Unlock()

	f.mu.Lock()
	if !f.dirty {
		f.mu.Unlock()
		return 0
	}
	body := bytes.Clone(f.cachedBody)
	generation := f.generation
	f.mu.Unlock()

	if errno := f.w.writeFile(f.relPath, body); errno != 0 {
		// Keep dirty=true on network or HTTP failures. The next Flush/Fsync
		// can retry the same local snapshot.
		return errno
	}

	f.mu.Lock()
	if f.generation == generation {
		f.dirty = false
		f.cachedAt = time.Now()
		f.loaded = true
	}
	// A write may have raced the upload. Leave that newer generation dirty;
	// the next Flush/Fsync will upload it without letting this older response
	// clear the local change.
	f.mu.Unlock()
	return 0
}

type fileHandle struct {
	f *fileNode
}

// ─── helpers ───────────────────────────────────────────────────────

func joinRel(parent, name string) string {
	if parent == "" {
		return name
	}
	return path.Join(parent, name)
}

// ─── main ──────────────────────────────────────────────────────────

func main() {
	if len(os.Args) != 4 {
		fmt.Fprintln(os.Stderr, "usage: cumora-fuse <runtime-base-url> <bearer-token> <mount-point>")
		os.Exit(2)
	}
	baseURL := os.Args[1]
	token := os.Args[2]
	mountPoint := os.Args[3]

	w := newWs(baseURL, token)
	// Probe once so we fail fast if the URL is wrong.
	if _, errno := w.stat(""); errno != 0 {
		log.Fatalf("[cumora-fuse] sanity-stat failed: errno=%d (is %s reachable?)", errno, baseURL)
	}

	root := &dirNode{w: w, relPath: ""}

	opts := &fs.Options{
		MountOptions: fuse.MountOptions{
			Name:          "cumora-workspace",
			FsName:        "cumora-workspace",
			AllowOther:    false,
			DisableXAttrs: true,
			Debug:         os.Getenv("CUMORA_FUSE_DEBUG") == "1",
			DirectMount:   false,
		},
		EntryTimeout:    durptr(0),
		AttrTimeout:     durptr(0),
		NegativeTimeout: durptr(0),
	}

	srv, err := fs.Mount(mountPoint, root, opts)
	if err != nil {
		log.Fatalf("[cumora-fuse] mount %q: %v", mountPoint, err)
	}
	log.Printf("[cumora-fuse] mounted at %s (backend %s)", mountPoint, baseURL)

	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		sig := <-sigs
		log.Printf("[cumora-fuse] %v received, unmounting", sig)
		// Schedule the hard-exit timer FIRST so we still exit even if
		// Unmount() ends up blocking on a stuck in-flight request.
		// go-fuse's Wait() is documented to return after Unmount, but
		// in practice we've seen it stall waiting on the IO loop. The
		// kernel mount goes away the moment Unmount returns; once it
		// does there's nothing useful left to do, so just leave.
		time.AfterFunc(3*time.Second, func() {
			log.Printf("[cumora-fuse] grace period elapsed, exit 0")
			os.Exit(0)
		})
		if err := srv.Unmount(); err != nil {
			log.Printf("[cumora-fuse] unmount error: %v", err)
		}
	}()

	srv.Wait()
}

func durptr(d time.Duration) *time.Duration { return &d }

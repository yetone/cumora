package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/hanwen/go-fuse/v2/fuse"
)

type fuseTestBackend struct {
	mu sync.Mutex

	files      map[string]string
	readCalls  int
	writeCalls []string
	failWrites bool

	firstWriteStarted  chan struct{}
	allowFirstWrite    chan struct{}
	secondWriteStarted chan struct{}
	allowSecondWrite   chan struct{}
	firstWriteRelease  sync.Once
	secondWriteRelease sync.Once
}

func newFuseTestBackend(files map[string]string) *fuseTestBackend {
	copyOfFiles := make(map[string]string, len(files))
	for path, body := range files {
		copyOfFiles[path] = body
	}
	return &fuseTestBackend{files: copyOfFiles}
}

func (b *fuseTestBackend) handler(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	switch r.Method + " " + r.URL.Path {
	case http.MethodGet + " /fs/read":
		b.mu.Lock()
		body, ok := b.files[path]
		b.readCalls++
		b.mu.Unlock()
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"body": body})
	case http.MethodPut + " /fs/write":
		var req struct {
			Path string `json:"path"`
			Body string `json:"body"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		b.mu.Lock()
		b.writeCalls = append(b.writeCalls, req.Body)
		writeNumber := len(b.writeCalls)
		if writeNumber == 1 && b.firstWriteStarted != nil {
			close(b.firstWriteStarted)
		}
		if writeNumber == 2 && b.secondWriteStarted != nil {
			close(b.secondWriteStarted)
		}
		allowFirst, allowSecond := b.allowFirstWrite, b.allowSecondWrite
		failWrite := b.failWrites
		b.mu.Unlock()

		if writeNumber == 1 && allowFirst != nil {
			<-allowFirst
		}
		if writeNumber == 2 && allowSecond != nil {
			<-allowSecond
		}
		if failWrite {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}

		b.mu.Lock()
		b.files[req.Path] = req.Body
		b.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func newFuseTestWorkspace(t *testing.T, backend *fuseTestBackend) (*ws, func()) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(backend.handler))
	return newWs(server.URL, "test-token"), server.Close
}

func newFileNodeForTest(w *ws, path string, body string) *fileNode {
	return &fileNode{
		w:          w,
		relPath:    path,
		cachedBody: []byte(body),
		cachedAt:   time.Now(),
		loaded:     true,
	}
}

func (b *fuseTestBackend) body(path string) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.files[path]
}

func (b *fuseTestBackend) reads() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.readCalls
}

func (b *fuseTestBackend) writes() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.writeCalls...)
}

func (b *fuseTestBackend) releaseFirstWrite() {
	if b.allowFirstWrite != nil {
		b.firstWriteRelease.Do(func() { close(b.allowFirstWrite) })
	}
}

func (b *fuseTestBackend) releaseSecondWrite() {
	if b.allowSecondWrite != nil {
		b.secondWriteRelease.Do(func() { close(b.allowSecondWrite) })
	}
}

func TestWriteGetattrFlushPreservesDirtyBody(t *testing.T) {
	backend := newFuseTestBackend(map[string]string{"notes.txt": "remote"})
	w, closeServer := newFuseTestWorkspace(t, backend)
	defer closeServer()
	f := &fileNode{w: w, relPath: "notes.txt"}

	if written, errno := f.Write(nil, nil, []byte("local!"), 0); errno != 0 || written != 6 {
		t.Fatalf("Write() = (%d, %d), want (6, 0)", written, errno)
	}
	var out fuse.AttrOut
	if errno := f.Getattr(nil, nil, &out); errno != 0 {
		t.Fatalf("Getattr() errno = %d", errno)
	}
	if got := out.Size; got != 6 {
		t.Fatalf("Getattr() size = %d, want 6", got)
	}
	if errno := f.Flush(nil, nil); errno != 0 {
		t.Fatalf("Flush() errno = %d", errno)
	}
	if got := backend.body("notes.txt"); got != "local!" {
		t.Fatalf("backend body = %q, want %q", got, "local!")
	}
	if got := backend.reads(); got != 1 {
		t.Fatalf("backend read calls = %d, want one hydration read", got)
	}
}

func TestSetattrTruncateHydratesExistingContent(t *testing.T) {
	backend := newFuseTestBackend(map[string]string{"notes.txt": "hello world"})
	w, closeServer := newFuseTestWorkspace(t, backend)
	defer closeServer()
	f := &fileNode{w: w, relPath: "notes.txt"}

	var in fuse.SetAttrIn
	in.Valid = fuse.FATTR_SIZE
	in.Size = 5
	var out fuse.AttrOut
	if errno := f.Setattr(nil, nil, &in, &out); errno != 0 {
		t.Fatalf("Setattr() errno = %d", errno)
	}
	if out.Size != 5 {
		t.Fatalf("Setattr() size = %d, want 5", out.Size)
	}
	if errno := f.Flush(nil, nil); errno != 0 {
		t.Fatalf("Flush() errno = %d", errno)
	}
	if got := backend.body("notes.txt"); got != "hello" {
		t.Fatalf("backend body = %q, want %q", got, "hello")
	}
	if got := backend.reads(); got != 1 {
		t.Fatalf("backend read calls = %d, want one hydration read", got)
	}
}

func TestExpiredDirtyCacheIsNotReplaced(t *testing.T) {
	backend := newFuseTestBackend(map[string]string{"notes.txt": "remote"})
	w, closeServer := newFuseTestWorkspace(t, backend)
	defer closeServer()
	f := newFileNodeForTest(w, "notes.txt", "local")
	f.cachedAt = time.Now().Add(-fileCacheTTL - time.Second)
	f.dirty = true

	var out fuse.AttrOut
	if errno := f.Getattr(nil, nil, &out); errno != 0 {
		t.Fatalf("Getattr() errno = %d", errno)
	}
	if out.Size != uint64(len("local")) {
		t.Fatalf("Getattr() size = %d, want local size", out.Size)
	}
	if got := backend.reads(); got != 0 {
		t.Fatalf("backend read calls = %d, want zero for dirty cache", got)
	}
}

func TestUncachedPartialWriteHydratesExistingContent(t *testing.T) {
	backend := newFuseTestBackend(map[string]string{"notes.txt": "abcdef"})
	w, closeServer := newFuseTestWorkspace(t, backend)
	defer closeServer()
	f := &fileNode{w: w, relPath: "notes.txt"}

	if written, errno := f.Write(nil, nil, []byte("XY"), 2); errno != 0 || written != 2 {
		t.Fatalf("Write() = (%d, %d), want (2, 0)", written, errno)
	}
	if errno := f.Flush(nil, nil); errno != 0 {
		t.Fatalf("Flush() errno = %d", errno)
	}
	if got := backend.body("notes.txt"); got != "abXYef" {
		t.Fatalf("backend body = %q, want %q", got, "abXYef")
	}
	if got := backend.reads(); got != 1 {
		t.Fatalf("backend read calls = %d, want one hydration read", got)
	}
}

func TestReadReturnsSnapshotIsolatedFromLaterWrites(t *testing.T) {
	backend := newFuseTestBackend(map[string]string{"notes.txt": "remote"})
	w, closeServer := newFuseTestWorkspace(t, backend)
	defer closeServer()
	f := newFileNodeForTest(w, "notes.txt", "old")

	result, errno := f.Read(nil, nil, make([]byte, 3), 0)
	if errno != 0 {
		t.Fatalf("Read() errno = %d", errno)
	}
	readBody, status := result.Bytes(nil)
	if status != fuse.OK {
		t.Fatalf("Read() status = %v, want OK", status)
	}
	if got := string(readBody); got != "old" {
		t.Fatalf("initial read = %q, want %q", got, "old")
	}
	if _, errno := f.Write(nil, nil, []byte("new"), 0); errno != 0 {
		t.Fatalf("Write() after Read() errno = %d", errno)
	}
	if got := string(readBody); got != "old" {
		t.Fatalf("read snapshot after later Write() = %q, want %q", got, "old")
	}

	body, errno := f.loadIfStale()
	if errno != 0 {
		t.Fatalf("loadIfStale() errno = %d", errno)
	}
	if got := string(body); got != "new" {
		t.Fatalf("cache after later Write() = %q, want %q", got, "new")
	}
}

func TestConcurrentWriteDuringFlushIsUploadedInOrder(t *testing.T) {
	backend := newFuseTestBackend(map[string]string{"notes.txt": "old"})
	backend.firstWriteStarted = make(chan struct{})
	backend.allowFirstWrite = make(chan struct{})
	backend.secondWriteStarted = make(chan struct{})
	backend.allowSecondWrite = make(chan struct{})
	w, closeServer := newFuseTestWorkspace(t, backend)
	defer closeServer()
	f := newFileNodeForTest(w, "notes.txt", "old")
	if _, errno := f.Write(nil, nil, []byte("one"), 0); errno != 0 {
		t.Fatalf("initial Write() errno = %d", errno)
	}

	defer backend.releaseFirstWrite()
	defer backend.releaseSecondWrite()

	flushDone := make(chan syscall.Errno, 1)
	go func() { flushDone <- f.Flush(nil, nil) }()
	select {
	case <-backend.firstWriteStarted:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for first upload")
	}

	if _, errno := f.Write(nil, nil, []byte("two"), 0); errno != 0 {
		t.Fatalf("racing Write() errno = %d", errno)
	}
	secondFlushDone := make(chan syscall.Errno, 1)
	go func() { secondFlushDone <- f.Flush(nil, nil) }()
	backend.releaseFirstWrite()
	select {
	case <-backend.secondWriteStarted:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for second upload")
	}

	select {
	case errno := <-flushDone:
		if errno != 0 {
			t.Fatalf("Flush() errno = %d", errno)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for Flush()")
	}
	if got := backend.body("notes.txt"); got != "one" {
		t.Fatalf("backend body = %q, want first generation %q", got, "one")
	}
	if !f.dirty {
		t.Fatal("file lost dirty state after a newer write raced the upload")
	}
	backend.releaseSecondWrite()
	select {
	case errno := <-secondFlushDone:
		if errno != 0 {
			t.Fatalf("overlapping Flush() errno = %d", errno)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for overlapping Flush()")
	}
	if got := backend.body("notes.txt"); got != "two" {
		t.Fatalf("backend body after overlapping second Flush() = %q, want newest generation %q", got, "two")
	}
	if got := backend.writes(); len(got) != 2 || got[0] != "one" || got[1] != "two" {
		t.Fatalf("upload bodies = %#v, want [one two]", got)
	}
	if f.dirty {
		t.Fatal("file remains dirty after newest generation was uploaded")
	}
}

func TestFlushFailureKeepsDirtyCacheForRetry(t *testing.T) {
	backend := newFuseTestBackend(map[string]string{"notes.txt": "remote"})
	backend.failWrites = true
	w, closeServer := newFuseTestWorkspace(t, backend)
	defer closeServer()
	f := newFileNodeForTest(w, "notes.txt", "local")
	f.dirty = true
	f.generation = 1

	if errno := f.Flush(nil, nil); errno == 0 {
		t.Fatal("Flush() succeeded for a failed HTTP write")
	}
	if !f.dirty {
		t.Fatal("file was marked clean after a failed upload")
	}
	backend.mu.Lock()
	backend.failWrites = false
	backend.mu.Unlock()
	if errno := f.Flush(nil, nil); errno != 0 {
		t.Fatalf("retry Flush() errno = %d", errno)
	}
	if got := backend.body("notes.txt"); got != "local" {
		t.Fatalf("backend body after retry = %q, want %q", got, "local")
	}
}

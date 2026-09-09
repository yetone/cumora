//go:build linux

package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

const (
	capVersion3          = 0x20080522
	prCapAmbient         = 47
	prCapAmbientClearAll = 4
)

func allThreadsPrctl(option, arg2, arg3 uintptr) error {
	_, _, errno := syscall.AllThreadsSyscall(syscall.SYS_PRCTL, option, arg2, arg3)
	if errno != 0 {
		return errno
	}
	return nil
}

func clearCapabilities() error {
	header := struct {
		version uint32
		pid     int32
	}{version: capVersion3}
	data := [2]struct {
		effective   uint32
		permitted   uint32
		inheritable uint32
	}{}
	_, _, errno := syscall.AllThreadsSyscall6(
		syscall.SYS_CAPSET,
		uintptr(unsafe.Pointer(&header)),
		uintptr(unsafe.Pointer(&data[0])),
		0, 0, 0, 0,
	)
	if errno != 0 {
		return errno
	}
	return nil
}

func capLast() (int, error) {
	b, err := os.ReadFile("/proc/sys/kernel/cap_last_cap")
	if err != nil {
		return 0, err
	}
	last, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || last < 0 {
		return 0, fmt.Errorf("invalid cap_last_cap: %q", string(b))
	}
	return last, nil
}

func validateTaskStatus(taskPath string) error {
	b, err := os.ReadFile(filepath.Join(taskPath, "status"))
	if err != nil {
		return err
	}
	return validateStatusText(string(b), taskPath)
}

func validateAllThreads() error {
	for pass := 0; pass < 2; pass++ {
		entries, err := os.ReadDir("/proc/self/task")
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if _, err := strconv.Atoi(entry.Name()); err != nil {
				continue
			}
			if err := validateTaskStatus(filepath.Join("/proc/self/task", entry.Name())); err != nil {
				// A thread may exit between ReadDir and status read. It cannot
				// become an unsafe surviving thread, so ignore only ENOENT and
				// fail closed for every other read/validation error.
				if errors.Is(err, os.ErrNotExist) {
					continue
				}
				return err
			}
		}
		// A second pass catches threads created while the first status set
		// was being read. New Go threads inherit this already-demoted
		// process context, but READY must still be based on an observed
		// all-thread check.
		if pass == 0 {
			continue
		}
	}
	return nil
}

func demoteAfterMountPlatform(parentPID int) error {
	// Every operation is applied to all current Go runtime threads. CGO=0 is
	// part of the production build contract; an unsupported all-thread syscall
	// is an error and never falls back to the calling thread only.
	const prSetNoNewPrivs = 38
	if err := allThreadsPrctl(prSetNoNewPrivs, 1, 0); err != nil {
		return fmt.Errorf("PR_SET_NO_NEW_PRIVS: %w", err)
	}
	if err := allThreadsPrctl(prCapAmbient, prCapAmbientClearAll, 0); err != nil {
		return fmt.Errorf("clear ambient capabilities: %w", err)
	}
	last, err := capLast()
	if err != nil {
		return err
	}
	// CAP_SETPCAP remains effective while the bounding set is cleared. The
	// subsequent UID transition and capset(2) remove the effective/permitted
	// sets; validation below proves every set is zero.
	for cap := 0; cap <= last; cap++ {
		if err := allThreadsPrctl(syscall.PR_CAPBSET_DROP, uintptr(cap), 0); err != nil {
			return fmt.Errorf("drop bounding capability %d: %w", cap, err)
		}
	}
	if err := syscall.Setgroups(nil); err != nil {
		return fmt.Errorf("clear supplementary groups: %w", err)
	}
	if err := syscall.Setresgid(fuseGID, fuseGID, fuseGID); err != nil {
		return fmt.Errorf("setresgid: %w", err)
	}
	if err := syscall.Setresuid(fuseUID, fuseUID, fuseUID); err != nil {
		return fmt.Errorf("setresuid: %w", err)
	}
	if err := clearCapabilities(); err != nil {
		return fmt.Errorf("capset zero: %w", err)
	}
	// Linux clears PDEATHSIG during a setuid transition. Re-arm it after the
	// transition and ensure the root bootstrap PID did not disappear during
	// the privilege drop.
	if err := allThreadsPrctl(syscall.PR_SET_PDEATHSIG, uintptr(syscall.SIGTERM), 0); err != nil {
		return fmt.Errorf("set parent-death signal: %w", err)
	}
	if os.Getppid() != parentPID {
		return fmt.Errorf("parent changed during privilege drop: got %d want %d", os.Getppid(), parentPID)
	}
	return validateAllThreads()
}

func readRootOnlyTokenPlatform(name string) (string, error) {
	fd, err := unix.Open(name, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return "", err
	}
	f := os.NewFile(uintptr(fd), name)
	if f == nil {
		_ = unix.Close(fd)
		return "", errors.New("token file descriptor unavailable")
	}
	defer f.Close()
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return "", err
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		return "", errors.New("token file is not a regular file")
	}
	if st.Uid != 0 || st.Gid != 0 || st.Mode&0777 != 0400 {
		return "", fmt.Errorf("token file must be root:root mode 0400 (uid=%d gid=%d mode=%#o)", st.Uid, st.Gid, st.Mode&0777)
	}
	if st.Size <= 0 || st.Size > 64*1024 {
		return "", errors.New("token file has invalid size")
	}
	b, err := io.ReadAll(io.LimitReader(f, 64*1024+1))
	if err != nil {
		return "", err
	}
	if len(b) > 64*1024 {
		return "", errors.New("token file is too large")
	}
	token := strings.TrimSpace(string(b))
	if token == "" {
		return "", errors.New("token file is empty")
	}
	return token, nil
}

func validateSecureParent(name string) error {
	parent := filepath.Dir(name)
	var st unix.Stat_t
	if err := unix.Lstat(parent, &st); err != nil {
		return err
	}
	if st.Mode&unix.S_IFMT != unix.S_IFDIR || st.Uid != 0 {
		return fmt.Errorf("log parent %q must be a root-owned directory", parent)
	}
	perm := st.Mode & 0777
	// /tmp is root-owned and sticky (01777), so it is acceptable when the
	// final component is opened with O_NOFOLLOW and verified as root:root
	// 0600. A non-sticky writable parent would permit replacement attacks.
	if st.Mode&01000 == 0 && (perm&0070 != 0 || perm&0002 != 0) {
		return fmt.Errorf("log parent %q is writable by a non-root process", parent)
	}
	return nil
}

func openSecureLogFilePlatform(name string) (*os.File, error) {
	if err := validateSecureParent(name); err != nil {
		return nil, err
	}
	fd, err := unix.Open(name, unix.O_WRONLY|unix.O_CREAT|unix.O_APPEND|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), name)
	if f == nil {
		_ = unix.Close(fd)
		return nil, errors.New("log file descriptor unavailable")
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		_ = f.Close()
		return nil, err
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG || st.Uid != 0 || st.Mode&0777 != 0600 {
		_ = f.Close()
		return nil, errors.New("log file must remain root-owned regular mode 0600")
	}
	return f, nil
}

func validateNotifierFD(fd int) (unix.Stat_t, error) {
	if fd < 3 {
		return unix.Stat_t{}, errors.New("notifier FD must be >= 3")
	}
	flags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0)
	if err != nil {
		return unix.Stat_t{}, err
	}
	if flags&unix.O_ACCMODE != unix.O_WRONLY && flags&unix.O_ACCMODE != unix.O_RDWR {
		return unix.Stat_t{}, errors.New("notifier FD is not writable")
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return unix.Stat_t{}, err
	}
	if st.Mode&unix.S_IFMT != unix.S_IFIFO {
		return unix.Stat_t{}, errors.New("notifier FD is not a pipe")
	}
	unix.CloseOnExec(fd)
	return st, nil
}

func prepareNotifierFDsPlatform(readyFD, lifetimeFD int) (*os.File, *os.File, error) {
	if readyFD == lifetimeFD {
		return nil, nil, errors.New("readiness and lifetime FDs must be distinct")
	}
	readyStat, err := validateNotifierFD(readyFD)
	if err != nil {
		return nil, nil, fmt.Errorf("ready FD %d: %w", readyFD, err)
	}
	lifetimeStat, err := validateNotifierFD(lifetimeFD)
	if err != nil {
		return nil, nil, fmt.Errorf("lifetime FD %d: %w", lifetimeFD, err)
	}
	if readyStat.Dev != lifetimeStat.Dev || readyStat.Ino != lifetimeStat.Ino {
		return nil, nil, errors.New("readiness and lifetime FDs must refer to the same pipe")
	}
	ready := os.NewFile(uintptr(readyFD), "cumora-fuse-ready")
	lifetime := os.NewFile(uintptr(lifetimeFD), "cumora-fuse-lifetime")
	if ready == nil || lifetime == nil {
		if ready != nil {
			_ = ready.Close()
		}
		if lifetime != nil {
			_ = lifetime.Close()
		}
		return nil, nil, errors.New("notifier FD unavailable")
	}
	return ready, lifetime, nil
}

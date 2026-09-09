//go:build linux

package main

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestReadRootOnlyTokenRejectsSymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "token")
	link := filepath.Join(dir, "token-link")
	if err := os.WriteFile(target, []byte("fixture-token"), 0400); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if _, err := readRootOnlyTokenPlatform(link); err == nil {
		t.Fatal("symlink token path was accepted")
	}
}

func TestReadRootOnlyTokenRejectsBroadPermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte("fixture-token"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readRootOnlyTokenPlatform(path); err == nil {
		t.Fatal("token file readable by non-root was accepted")
	}
}

func TestPrepareNotifierFDsRejectsRegularFiles(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "notifier")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, _, err := prepareNotifierFDsPlatform(int(f.Fd()), int(f.Fd())+1); err == nil {
		t.Fatal("regular file was accepted as notifier pipe")
	}
}

func TestPrepareNotifierFDsRequiresTheSamePipe(t *testing.T) {
	readyReader, readyWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer readyReader.Close()
	defer readyWriter.Close()
	lifetimeReader, lifetimeWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer lifetimeReader.Close()
	defer lifetimeWriter.Close()
	if _, _, err := prepareNotifierFDsPlatform(int(readyWriter.Fd()), int(lifetimeWriter.Fd())); err == nil {
		t.Fatal("write ends of different pipes were accepted")
	}
}

func TestPrepareNotifierFDsAcceptsDistinctWriteEndsOfTheSamePipe(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	dup, err := unix.Dup(int(writer.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	ready, lifetime, err := prepareNotifierFDsPlatform(int(writer.Fd()), dup)
	if err != nil {
		_ = unix.Close(dup)
		t.Fatalf("same-pipe notifier FDs rejected: %v", err)
	}
	if err := ready.Close(); err != nil {
		t.Fatal(err)
	}
	if err := lifetime.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestOpenSecureLogFileRejectsFinalSymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target.log")
	link := filepath.Join(dir, "fuse.log")
	if err := os.WriteFile(target, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if _, err := openSecureLogFilePlatform(link); err == nil {
		t.Fatal("log symlink was followed")
	}
}

package main

import (
	"io"
	"os"
	"strings"
	"testing"
)

func TestParseRuntimeConfigUsesOnlyNonSecretArguments(t *testing.T) {
	cfg, err := parseRuntimeConfig([]string{
		"--runtime-base-url", "http://server.example/runtime/",
		"--mount-point", "/workspace",
		"--token-file", "/run/cumora/fuse-token",
		"--ready-fd", "4",
		"--lifetime-fd", "5",
		"--log-file", "/run/cumora/fuse.log",
	})
	if err != nil {
		t.Fatalf("parseRuntimeConfig() error = %v", err)
	}
	if cfg.baseURL != "http://server.example/runtime" {
		t.Fatalf("baseURL = %q, want trailing slash trimmed", cfg.baseURL)
	}
	if cfg.tokenFile != "/run/cumora/fuse-token" {
		t.Fatalf("tokenFile = %q", cfg.tokenFile)
	}
	if cfg.readyFD != 4 || cfg.lifetimeFD != 5 {
		t.Fatalf("notifier FDs = (%d, %d), want (4, 5)", cfg.readyFD, cfg.lifetimeFD)
	}
}

func TestParseRuntimeConfigRejectsBearerInArgvAndUnsafeInputs(t *testing.T) {
	cases := [][]string{
		{"http://server/runtime", "secret-token", "/workspace"},
		{"--runtime-base-url", "http://user:secret@server/runtime", "--mount-point", "/workspace", "--token-file", "/run/t", "--ready-fd", "4", "--lifetime-fd", "5"},
		{"--runtime-base-url", "http://server/runtime", "--mount-point", "/", "--token-file", "/run/t", "--ready-fd", "4", "--lifetime-fd", "5"},
		{"--runtime-base-url", "http://server/runtime", "--mount-point", "/workspace", "--token-file", "/run/t", "--ready-fd", "4", "--lifetime-fd", "4"},
	}
	for i, args := range cases {
		if _, err := parseRuntimeConfig(args); err == nil {
			t.Fatalf("case %d unexpectedly accepted unsafe arguments", i)
		}
	}
}

func TestValidateStatusTextRequiresFixedUIDCapsAndNoNewPrivs(t *testing.T) {
	good := "Uid:\t65533\t65533\t65533\t65533\n" +
		"Gid:\t65533\t65533\t65533\t65533\n" +
		"Groups:\t\n" +
		"CapInh:\t0000000000000000\n" +
		"CapPrm:\t0000000000000000\n" +
		"CapEff:\t0000000000000000\n" +
		"CapBnd:\t0000000000000000\n" +
		"CapAmb:\t0000000000000000\n" +
		"NoNewPrivs:\t1\n"
	if err := validateStatusText(good, "/proc/self/task/1"); err != nil {
		t.Fatalf("validateStatusText(good) error = %v", err)
	}
	for name, bad := range map[string]string{
		"uid":            replaceStatus(good, "Uid:", "65532 65532 65532 65533"),
		"uid-saved-root": replaceStatus(good, "Uid:", "65533 65533 0 65533"),
		"uid-fs-root":    replaceStatus(good, "Uid:", "65533 65533 65533 0"),
		"gid":            replaceStatus(good, "Gid:", "65532 65532 65532 65533"),
		"gid-saved-root": replaceStatus(good, "Gid:", "65533 65533 0 65533"),
		"gid-fs-root":    replaceStatus(good, "Gid:", "65533 65533 65533 0"),
		"caps":           replaceStatus(good, "CapEff:", "0000000000000001"),
		"nnp":            replaceStatus(good, "NoNewPrivs:", "0"),
		"grp":            replaceStatus(good, "Groups:", "1000"),
	} {
		if err := validateStatusText(bad, "/proc/self/task/1"); err == nil {
			t.Errorf("validateStatusText(%s) unexpectedly accepted insecure status", name)
		}
	}
}

func replaceStatus(status, key, value string) string {
	lines := strings.Split(status, "\n")
	for i, line := range lines {
		if strings.HasPrefix(line, key) {
			lines[i] = key + "\t" + value
			return strings.Join(lines, "\n")
		}
	}
	return status
}

func TestWriteReadyMarkerClosesOnlyTheReadyWriter(t *testing.T) {
	readyReader, readyWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer readyReader.Close()
	lifetimeReader, lifetimeWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer lifetimeReader.Close()
	defer lifetimeWriter.Close()

	if err := writeReadyMarker(readyWriter); err != nil {
		t.Fatalf("writeReadyMarker() error = %v", err)
	}
	ready, err := io.ReadAll(readyReader)
	if err != nil {
		t.Fatal(err)
	}
	if string(ready) != "READY\n" {
		t.Fatalf("ready marker = %q", ready)
	}
	if _, err := lifetimeWriter.Write([]byte("alive")); err != nil {
		t.Fatalf("lifetime writer closed with ready FD: %v", err)
	}
	buf := make([]byte, 5)
	if _, err := io.ReadFull(lifetimeReader, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "alive" {
		t.Fatalf("lifetime marker = %q", buf)
	}
}

func TestUnsupportedPlatformBoundaryIsExplicit(t *testing.T) {
	if errLinuxBoundaryUnsupported == nil {
		t.Fatal("unsupported-platform error must be non-nil")
	}
}

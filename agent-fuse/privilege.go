package main

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

const (
	modelUID = 65532
	modelGID = 65532
	fuseUID  = 65533
	fuseGID  = 65533
)

var errLinuxBoundaryUnsupported = errors.New("FUSE privilege boundary requires Linux all-thread syscalls")

func statusFields(status, key string) ([]string, bool) {
	for _, line := range strings.Split(status, "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && strings.TrimSuffix(fields[0], ":") == key {
			return fields[1:], true
		}
	}
	return nil, false
}

func statusValue(status, key string) (string, bool) {
	values, ok := statusFields(status, key)
	if !ok || len(values) == 0 {
		return "", false
	}
	return values[0], true
}

func validateStatusText(status, taskPath string) error {
	for key, want := range map[string]int{"Uid": fuseUID, "Gid": fuseGID} {
		values, ok := statusFields(status, key)
		wantValue := strconv.Itoa(want)
		if !ok || len(values) != 4 {
			return fmt.Errorf("task %s %s=%q, want four identity fields all %d", taskPath, key, values, want)
		}
		for index, value := range values {
			if value != wantValue {
				return fmt.Errorf("task %s %s[%d]=%q, want %d", taskPath, key, index, value, want)
			}
		}
	}
	for _, key := range []string{"CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"} {
		value, ok := statusValue(status, key)
		if !ok || strings.TrimLeft(strings.ToLower(value), "0") != "" {
			return fmt.Errorf("task %s %s=%q, want zero", taskPath, key, value)
		}
	}
	noNewPrivs, ok := statusValue(status, "NoNewPrivs")
	if !ok || noNewPrivs != "1" {
		return fmt.Errorf("task %s NoNewPrivs=%q, want 1", taskPath, noNewPrivs)
	}
	groupsSeen := false
	for _, line := range strings.Split(status, "\n") {
		if strings.HasPrefix(line, "Groups:") && strings.TrimSpace(strings.TrimPrefix(line, "Groups:")) != "" {
			return fmt.Errorf("task %s has supplementary groups: %q", taskPath, line)
		}
		if strings.HasPrefix(line, "Groups:") {
			groupsSeen = true
		}
	}
	if !groupsSeen {
		return fmt.Errorf("task %s Groups field is missing", taskPath)
	}
	return nil
}

func writeReadyMarker(readyFD *os.File) error {
	if readyFD == nil {
		return errors.New("readiness FD is unavailable")
	}
	defer readyFD.Close()
	const marker = "READY\n"
	n, err := readyFD.WriteString(marker)
	if err != nil {
		return err
	}
	if n != len(marker) {
		return fmt.Errorf("short readiness marker write: %d/%d bytes", n, len(marker))
	}
	return nil
}

// The platform files provide the security-sensitive implementations. The
// non-Linux build remains compilable for static/unit tests but fails closed if
// someone tries to run the boundary there.
func demoteAfterMount(parentPID int) error            { return demoteAfterMountPlatform(parentPID) }
func readRootOnlyToken(name string) (string, error)   { return readRootOnlyTokenPlatform(name) }
func openSecureLogFile(name string) (*os.File, error) { return openSecureLogFilePlatform(name) }
func prepareNotifierFDs(readyFD, lifetimeFD int) (*os.File, *os.File, error) {
	return prepareNotifierFDsPlatform(readyFD, lifetimeFD)
}

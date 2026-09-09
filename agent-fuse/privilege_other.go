//go:build !linux

package main

import (
	"errors"
	"os"
)

func demoteAfterMountPlatform(int) error { return errLinuxBoundaryUnsupported }

func readRootOnlyTokenPlatform(string) (string, error) {
	return "", errLinuxBoundaryUnsupported
}

func openSecureLogFilePlatform(string) (*os.File, error) {
	return nil, errLinuxBoundaryUnsupported
}

func prepareNotifierFDsPlatform(int, int) (*os.File, *os.File, error) {
	return nil, nil, errors.New("readiness/lifetime pipes require Linux")
}

package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"path/filepath"
	"strings"
)

// runtimeConfig is intentionally limited to non-secret launch parameters.
// The bearer is read from a root-only file after the process starts and never
// accepted as an argv value.
type runtimeConfig struct {
	baseURL    string
	mountPoint string
	tokenFile  string
	logFile    string
	readyFD    int
	lifetimeFD int
}

func parseRuntimeConfig(args []string) (runtimeConfig, error) {
	var cfg runtimeConfig
	fs := flag.NewFlagSet("cumora-fuse", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&cfg.baseURL, "runtime-base-url", "", "runtime server base URL")
	fs.StringVar(&cfg.mountPoint, "mount-point", "", "FUSE mount point")
	fs.StringVar(&cfg.tokenFile, "token-file", "", "root-only bearer token file")
	fs.StringVar(&cfg.logFile, "log-file", "", "optional FUSE log file")
	fs.IntVar(&cfg.readyFD, "ready-fd", -1, "write-only readiness pipe FD")
	fs.IntVar(&cfg.lifetimeFD, "lifetime-fd", -1, "write-only lifetime pipe FD")
	if err := fs.Parse(args); err != nil {
		return runtimeConfig{}, err
	}
	if fs.NArg() != 0 {
		return runtimeConfig{}, fmt.Errorf("unexpected positional arguments")
	}
	if cfg.baseURL == "" {
		return runtimeConfig{}, errors.New("--runtime-base-url is required")
	}
	u, err := url.Parse(cfg.baseURL)
	if err != nil || u.Scheme == "" || u.Host == "" || u.User != nil || u.Fragment != "" {
		return runtimeConfig{}, errors.New("--runtime-base-url must be an absolute http(s) URL without userinfo or fragment")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return runtimeConfig{}, errors.New("--runtime-base-url must use http or https")
	}
	cfg.baseURL = strings.TrimRight(cfg.baseURL, "/")
	if cfg.mountPoint == "" || !filepath.IsAbs(cfg.mountPoint) || filepath.Clean(cfg.mountPoint) == "/" {
		return runtimeConfig{}, errors.New("--mount-point must be an absolute non-root path")
	}
	if cfg.tokenFile == "" || !filepath.IsAbs(cfg.tokenFile) {
		return runtimeConfig{}, errors.New("--token-file must be an absolute path")
	}
	if cfg.logFile != "" && !filepath.IsAbs(cfg.logFile) {
		return runtimeConfig{}, errors.New("--log-file must be an absolute path")
	}
	if cfg.readyFD < 3 || cfg.lifetimeFD < 3 || cfg.readyFD == cfg.lifetimeFD {
		return runtimeConfig{}, errors.New("--ready-fd and --lifetime-fd must be distinct inherited FDs >= 3")
	}
	return cfg, nil
}

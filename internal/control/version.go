package control

import (
	"runtime/debug"
)

// buildRevision returns the VCS revision embedded by the Go toolchain at
// build time. For module builds without VCS metadata (e.g. GOPATH, vendor,
// or stripped builds) it returns "unknown".
func buildRevision() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "unknown"
	}
	for _, setting := range info.Settings {
		if setting.Key == "vcs.revision" {
			return setting.Value
		}
	}
	return "unknown"
}

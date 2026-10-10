package control

import (
	"runtime/debug"
)

// revisionFromBuildInfo extracts the VCS revision from a debug.BuildInfo.
// If no revision is present it returns "unknown".
func revisionFromBuildInfo(info *debug.BuildInfo) string {
	if info == nil {
		return "unknown"
	}
	for _, setting := range info.Settings {
		if setting.Key == "vcs.revision" {
			return setting.Value
		}
	}
	return "unknown"
}

// buildRevision returns the VCS revision embedded by the Go toolchain at
// build time. For module builds without VCS metadata (e.g. GOPATH, vendor,
// or stripped builds) it returns "unknown".
func buildRevision() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "unknown"
	}
	return revisionFromBuildInfo(info)
}

package tools

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func writeN(t *testing.T, dir string, n int, ext string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < n; i++ {
		p := filepath.Join(dir, fmt.Sprintf("f%03d%s", i, ext))
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func regionFileCount(regions []Region, path string) (int, bool) {
	for _, r := range regions {
		if r.Path == path {
			return r.FileCount, true
		}
	}
	return 0, false
}

func TestScanRegionsSmallTreeIsOneRegion(t *testing.T) {
	root := t.TempDir()
	writeN(t, root, 2, ".go")
	writeN(t, filepath.Join(root, "sub"), 3, ".go")

	regions, err := ScanRegions(root, 150)
	if err != nil {
		t.Fatal(err)
	}
	if len(regions) != 1 {
		t.Fatalf("expected 1 region for a small tree, got %d: %+v", len(regions), regions)
	}
	if regions[0].Path != "." || regions[0].FileCount != 5 {
		t.Fatalf("expected root region \".\" with 5 files, got %+v", regions[0])
	}
}

func TestScanRegionsSplitsOversizedDirectories(t *testing.T) {
	root := t.TempDir()
	writeN(t, root, 2, ".md")
	writeN(t, filepath.Join(root, "a"), 200, ".go")
	writeN(t, filepath.Join(root, "b"), 5, ".go")

	regions, err := ScanRegions(root, 100)
	if err != nil {
		t.Fatal(err)
	}

	if n, ok := regionFileCount(regions, "."); !ok || n != 2 {
		t.Errorf("expected root region \".\" with 2 loose files, got %d (found=%v): %+v", n, ok, regions)
	}
	// "a" has no subdirectories to divide on, so it stays one oversized region
	// rather than being force-split — there is nothing left for code to split by.
	if n, ok := regionFileCount(regions, "a"); !ok || n != 200 {
		t.Errorf("expected region \"a\" with 200 files, got %d (found=%v): %+v", n, ok, regions)
	}
	if n, ok := regionFileCount(regions, "b"); !ok || n != 5 {
		t.Errorf("expected region \"b\" with 5 files, got %d (found=%v): %+v", n, ok, regions)
	}
}

func TestScanRegionsRecursesIntoNestedDirectories(t *testing.T) {
	root := t.TempDir()
	writeN(t, filepath.Join(root, "big", "x"), 60, ".ts")
	writeN(t, filepath.Join(root, "big", "y"), 60, ".ts")

	regions, err := ScanRegions(root, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(regions) != 2 {
		t.Fatalf("expected 2 regions, got %d: %+v", len(regions), regions)
	}
	if n, ok := regionFileCount(regions, "big/x"); !ok || n != 60 {
		t.Errorf("expected region \"big/x\" with 60 files, got %d (found=%v): %+v", n, ok, regions)
	}
	if n, ok := regionFileCount(regions, "big/y"); !ok || n != 60 {
		t.Errorf("expected region \"big/y\" with 60 files, got %d (found=%v): %+v", n, ok, regions)
	}
}

func TestScanRegionsSkipsIgnoredDirectories(t *testing.T) {
	root := t.TempDir()
	writeN(t, root, 1, ".go")
	writeN(t, filepath.Join(root, "node_modules", "pkg"), 50, ".js")

	regions, err := ScanRegions(root, 150)
	if err != nil {
		t.Fatal(err)
	}
	total := 0
	for _, r := range regions {
		if r.Path == "node_modules" {
			t.Fatalf("node_modules should have been skipped, got region %+v", r)
		}
		total += r.FileCount
	}
	if total != 1 {
		t.Fatalf("expected only the 1 non-ignored file to be counted, got %d across %+v", total, regions)
	}
}

func TestScanRegionsReportsLanguages(t *testing.T) {
	root := t.TempDir()
	writeN(t, filepath.Join(root, "src"), 3, ".go")
	writeN(t, filepath.Join(root, "src"), 2, ".ts")

	regions, err := ScanRegions(root, 150)
	if err != nil {
		t.Fatal(err)
	}
	if len(regions) != 1 {
		t.Fatalf("expected 1 region, got %d: %+v", len(regions), regions)
	}
	if regions[0].Languages["go"] != 3 || regions[0].Languages["ts"] != 2 {
		t.Fatalf("expected go=3 ts=2, got %+v", regions[0].Languages)
	}
}

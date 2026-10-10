const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    // The instrumenter runs on every keystroke of every Zig session, and a
    // Debug build took ~9 ms per file against ~1 ms optimised: more than the
    // incremental compile it feeds. ReleaseSafe unless a release mode is
    // asked for (`-Dinstrumenter-optimize=Debug` to debug it), keeping the
    // safety checks since its input is whatever the user typed. The tests
    // keep the requested mode.
    const instrumenter_optimize = b.option(
        std.builtin.OptimizeMode,
        "instrumenter-optimize",
        "Optimization mode for runzig-instrument (default: ReleaseSafe)",
    ) orelse if (optimize == .Debug) .ReleaseSafe else optimize;

    const instrumenter = b.addExecutable(.{
        .name = "runzig-instrument",
        .root_module = b.createModule(.{
            .root_source_file = b.path("zig/instrumenter/src/main.zig"),
            .target = target,
            .optimize = instrumenter_optimize,
        }),
    });
    b.installArtifact(instrumenter);

    const instrumenter_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("zig/instrumenter/src/AstAdapter.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    const runtime_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("zig/runtime/runzig_runtime.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    const test_step = b.step("test", "Run Zig instrumenter and runtime tests");
    test_step.dependOn(&b.addRunArtifact(instrumenter_tests).step);
    test_step.dependOn(&b.addRunArtifact(runtime_tests).step);
}

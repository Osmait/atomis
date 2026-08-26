const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const instrumenter = b.addExecutable(.{
        .name = "runzig-instrument",
        .root_module = b.createModule(.{
            .root_source_file = b.path("zig/instrumenter/src/main.zig"),
            .target = target,
            .optimize = optimize,
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

const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{ .preferred_optimize_mode = .Debug });

    const check_exe = b.addExecutable(.{
        .name = "ziglive-check",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    const check = b.step("check", "Analyze the visible source without installing it");
    check.dependOn(&check_exe.step);

    const executable = b.addExecutable(.{
        .name = "ziglive-session",
        .root_module = b.createModule(.{
            .root_source_file = b.path("generated/main.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });
    const install = b.addInstallArtifact(executable, .{});
    const instrumented = b.step("instrumented", "Build the instrumented snapshot");
    instrumented.dependOn(&install.step);

    const tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("test_root.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
        .test_runner = .{ .path = b.path("runzig_test_runner.zig"), .mode = .simple },
    });
    const install_tests = b.addInstallArtifact(tests, .{ .dest_sub_path = "ziglive-tests" });
    const tests_step = b.step("tests", "Build the visible-source test binary");
    tests_step.dependOn(&install_tests.step);
}

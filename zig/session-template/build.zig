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
}

const std = @import("std");
// Read at comptime so every dependency saved by `zig fetch --save` is
// wired without editing this file.
const manifest = @import("build.zig.zon");

/// Adds every dependency the manifest declares to `module`, by the usual
/// convention that a package exports a module named after itself. A
/// package that exports something else is skipped rather than crashing
/// the build: the import simply stays unresolved, and the compiler says
/// so on the line that needs it.
fn addDependencies(
    b: *std.Build,
    module: *std.Build.Module,
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
) void {
    if (!@hasField(@TypeOf(manifest), "dependencies")) return;
    inline for (@typeInfo(@TypeOf(manifest.dependencies)).@"struct".fields) |entry| {
        const dependency = b.dependency(entry.name, .{
            .target = target,
            .optimize = optimize,
        });
        if (dependency.builder.modules.get(entry.name)) |exported| {
            module.addImport(entry.name, exported);
        }
    }
}

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{ .preferred_optimize_mode = .Debug });

    const check_exe = b.addExecutable(.{
        .name = "atomis-check",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    addDependencies(b, check_exe.root_module, target, optimize);
    const check = b.step("check", "Analyze the visible source without installing it");
    check.dependOn(&check_exe.step);

    const executable = b.addExecutable(.{
        .name = "atomis-session",
        .root_module = b.createModule(.{
            .root_source_file = b.path("generated/main.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });
    addDependencies(b, executable.root_module, target, optimize);
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
    addDependencies(b, tests.root_module, target, optimize);
    const install_tests = b.addInstallArtifact(tests, .{ .dest_sub_path = "atomis-tests" });
    const tests_step = b.step("tests", "Build the visible-source test binary");
    tests_step.dependOn(&install_tests.step);
}

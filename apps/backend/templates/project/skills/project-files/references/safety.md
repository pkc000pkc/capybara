# File Safety

- Do not use absolute paths or traverse outside the project workspace.
- Treat the selected project root as the only authority for resolving paths.
- Do not follow symbolic links during broad traversal unless the runtime separately verifies their targets.
- Treat deletes and overwrites as explicit operations.
- Prefer narrow reads and searches for large projects.
- Bound recursive operations by depth and entry count.
- Report tool validation or permission failures without hiding them.

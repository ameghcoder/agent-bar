// T403: which window, if any, runs a session's agent process. Pure and
// import-free, so GNOME Shell and Node's tests load the same file; the caller
// supplies how to read /proc/<pid>/stat and which windows exist.
//
// The rule is to never guess. A target is returned only when exactly one
// window can be named: the wrong window coming forward is worse than nothing.

// Field 4 of /proc/<pid>/stat. The process name in field 2 may hold spaces and
// parentheses, so fields are counted from the last ')'.
export function parentPid(stat) {
    const close = stat.lastIndexOf(')');
    if (close === -1)
        return undefined;
    const value = Number(stat.slice(close + 2).split(' ')[1]);
    return Number.isInteger(value) && value > 0 ? value : undefined;
}

// The process and its ancestors, nearest first, stopping before init (PID 1),
// at an unreadable entry, at a loop, or after `limit` steps.
export function ancestorsOf(pid, readStat, limit = 64) {
    const chain = [];
    let current = pid;
    while (current > 1 && chain.length < limit && !chain.includes(current)) {
        chain.push(current);
        const stat = readStat(current);
        const parent = stat === undefined ? undefined : parentPid(stat);
        if (parent === undefined)
            break;
        current = parent;
    }
    return chain;
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// `windows` are {pid, title, ...}; the matching entry is returned as given.
// The nearest ancestor that owns any window decides: a terminal started from
// an editor beats the editor. When that process owns several windows (Ptyxis,
// GNOME Terminal, and VS Code each run every window from one process), only
// a title naming the project as a whole word picks one; otherwise nothing.
export function pickWindow(ancestors, windows, projectName) {
    for (const pid of ancestors) {
        const owned = windows.filter(window => window.pid === pid);
        if (owned.length === 0)
            continue;
        if (owned.length === 1)
            return owned[0];
        const word = new RegExp(`(^|[^\\w-])${escapeRegExp(projectName)}($|[^\\w-])`);
        const named = owned.filter(window => word.test(window.title ?? ''));
        return named.length === 1 ? named[0] : null;
    }
    return null;
}

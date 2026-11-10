// Every change the probe makes that a page could notice, in one table.
//
// The session status prints this table. A change the page can observe that is missing from
// it is a bug (06-BUILD-PLAN.md, section 7). In unmodified mode none of the entries marked
// `optional` are applied.

export interface Modification
{
    id: string;
    what: string;
    why: string;

    // Optional changes are skipped in unmodified mode. The rest are what makes the probe a
    // probe (wrapped functions, the virtual clock) and cannot be turned off.
    optional: boolean;
    active: () => boolean;
}

const table: Modification[] = [];

export function declare (modification: Modification): void
{
    table.push(modification);
}

export function modifications (): Array<{ id: string; what: string; why: string; optional: boolean; active: boolean }>
{
    return table.map((entry) => ({
        id: entry.id,
        what: entry.what,
        why: entry.why,
        optional: entry.optional,
        active: entry.active()
    }));
}

// Things the probe has noticed that limit what it can do on this page.
const warnings = new Map<string, string>();

export function warn (id: string, text: string): void
{
    warnings.set(id, text);
}

export function clearWarning (id: string): void
{
    warnings.delete(id);
}

export function currentWarnings (): Array<{ id: string; text: string }>
{
    return [...warnings].map(([id, text]) => ({ id, text }));
}

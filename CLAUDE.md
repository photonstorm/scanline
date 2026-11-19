# Scanline

Read [docs/HANDOVER.md](docs/HANDOVER.md) before doing anything: it has the owner's standing instructions, how to build and test, and what to do next.

The short of it: commit and push to `main` without asking as each piece of work is finished and tested; carry on without stopping to ask; write documentation in plain British English; ask before fetching code from outside; never run two test runs at once.

**Test only what you changed.** After a change, run the tests of that feature and of what sits next to it, by name or by group, and nothing more. Never run the whole suite (`npm test`, or every group in turn) unless the owner asks for it, which is before a release to the public. The whole suite once took two hours and took over the owner's Mac. [docs/HANDOVER.md](docs/HANDOVER.md), "Testing a change", says which tests go with which part.

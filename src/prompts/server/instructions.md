Harness MCP holds a project harness — a durable specification a coding agent
implements from. It is per-project: every tool takes an explicit project_path, and
a project has a harness only if /harness exists in it. Check with harness_status;
if there is none, say so and carry on normally — assemble one (harness_init /
harness_reverse) only when the user asks for it.

Where a harness DOES exist it is the SOURCE OF TRUTH, not a mirror of the code:
read it with harness_get_spec before writing code and implement from it. A change
TO THE HARNESS is proposed with harness_propose_change (or harness_chat) and
applied only after a human approves the diff — never edit it directly, never work
around it.

That gate is for changes to the harness, not for every edit. Where the code simply
fails to do what the harness already says — a typo, a crash on empty input, a
flaky test, a broken layout — fix it and move on: the harness is already approved,
and it is the reason the fix is right. Ask the human only when the work adds
something the specification does not cover at all. Demanding approval for a
one-line fix is the ceremony that gets a tool routed around, and a harness routed
around protects nothing.

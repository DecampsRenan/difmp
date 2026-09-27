---
version: 1
id: mixed-problems
fixture: ghost-fixture
checks:
  c2: ghost-check
inputs:
  broken: "{{ nope }}"
---

# Mixed problems

Open {{ nopeEither }}.

## Expected results

- The {{ nopeTwo }} thing shows.
- Second expectation with {{ nopeThree }}.

# Start with a Guarded Document Replace Slice

Status: accepted

The first implementation slice will validate existing-document Zilliz publish end to end before enabling fine-grained write strategies. It may support guarded document replacement as the only real write path while block patch and section replace remain plan-only.

This is a staged implementation choice, not a reversal of the collaboration-state safety model. Whole-document replacement still requires explicit destructive strategy selection and confirmation; automatic writes must not silently choose document replacement.

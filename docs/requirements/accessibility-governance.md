# Accessibility governance

The [conformance plan](accessibility-plan.md) sets the project standard.
Every interactive component must support keyboard operation, visible focus,
accessible names and states, sufficient contrast, clear labels and errors,
reduced motion, and meaningful document structure.

Use native semantics first. Meet the WCAG 2.2 target-size requirement, with larger
targets where possible. Text needs 4.5:1 contrast, or 3:1 for large text. Meaningful
graphics and interface boundaries need 3:1 where the standard requires it.

Each component has [acceptance criteria](component-accessibility-criteria.md).
Verify behavior with automated checks, keyboard use, and a screen reader.
A markup snapshot alone does not prove keyboard operation.

The deployment owner assigns an accountable accessibility contact and maintains
a public statement, known limitations, and feedback path. Acknowledge reports
within five business days, assign severity, and track them through repair.
Route barriers in embedded services to the provider and retain responsibility
for the local fallback and user response.

Review accessibility before release and audit at least quarterly. Require an
Accessibility Conformance Report and an in-place acceptance test when procuring
a component that users will interact with.

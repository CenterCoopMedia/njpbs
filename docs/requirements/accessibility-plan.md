# Accessibility conformance plan

The project requires WCAG 2.1 level AA and targets WCAG 2.2 level AA.
Apply accessibility requirements during design, implementation, and review.
The deployment owner must confirm applicable legal duties and compliance dates
for the service it operates.

## Verification

- Run automated accessibility scans on representative pages and critical flows.
- Test keyboard operation, tab order, focus visibility, labels, and error messages.
- Test reflow at 200 percent and 400 percent zoom.
- Test with screen readers on more than one supported platform.
- Check meaningful alternative text, decorative images, and caption quality.
- Test embedded services in place and provide a usable fallback for failures.
- Honor reduced motion and avoid media that starts with sound.

Automation covers only part of the requirement. Record manual findings and map
each barrier to a success criterion, severity, and repair.

## Release checks

Run focused checks for changed components. Before a release, test the schedule,
video player, search, forms, and other affected user flows. Run a full audit at
least quarterly and before launch. A regression in keyboard or assistive
technology support must be repaired before release.

See [governance](accessibility-governance.md),
[component criteria](component-accessibility-criteria.md), and the
[compliance checklist](compliance-matrix.md).

## References

- [WCAG 2.1](https://www.w3.org/TR/WCAG21/)
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- [WAI evaluation guidance](https://www.w3.org/WAI/test-evaluate/)

# Accessibility and media compliance checklist

Use this checklist during implementation. The deployment owner confirms which
legal and broadcast requirements apply to its service.

| Area | Required project behavior | Evidence |
| --- | --- | --- |
| Accessibility | Meet WCAG 2.1 AA; target WCAG 2.2 AA. | Automated, keyboard, reflow, and screen-reader checks. |
| Video captions | Preserve supplied captions and verify their presence and quality. | Player checks on representative content. |
| Audio description | Preserve available described-audio tracks. | Playback and track-selection checks. |
| Public file | Keep configured regulatory links and assistance contacts accessible. | Public page and footer checks. |
| Feedback | Keep a working accessibility feedback path. | Keyboard, form, and response checks. |
| Third-party services | Test embedded services in place and retain fallbacks. | Acceptance checks and provider reports. |
| Privacy | Keep private records and credentials out of public artifacts. | Source, fixture, log, and artifact review. |

See the [conformance plan](accessibility-plan.md) and
[component criteria](component-accessibility-criteria.md).

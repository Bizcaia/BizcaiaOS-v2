# Frontend QA Notes

## Desktop verification

The BizcaiaOS dashboard loaded successfully at the local preview URL. The Team navigation item opens the organization and people workspace without the property drawer obscuring the page.

The member directory rendered five members with role selectors, active/inactive controls, joined dates, current-user protection, and removal menus. The metrics correctly displayed four active members, one System Administrator, and one pending invitation.

The invitation modal opened correctly. A test invitation for `ana.delacruz@northcorridor.ph` with the Supervisor role completed in preview mode. The interface moved to the Invitations tab, increased the pending count from one to two, displayed the new invitation, and exposed a one-time demo token with a copy action.

The onboarding preview rendered as a full-screen branded setup experience with organization name, auto-generated workspace slug, timezone selection, security explanations, and a clear preview-mode disclosure.

## Mobile verification

At 390 × 844, the onboarding layout stacks cleanly: the brand and close control remain visible, the headline wraps without clipping, security benefits become a vertical list, and the organization form begins below the narrative with full-width controls.

The first Team mobile capture occurred before the preview adapter’s asynchronous data load completed, so it correctly displayed the mobile skeleton state. A delayed capture is required to inspect the populated member-management state.

The delayed Team capture confirmed the populated responsive state. At 390 × 844, the icon sidebar remains usable, the access-control heading and actions wrap cleanly, metrics stack into full-width cards, and the tab bar remains visible without horizontal page overflow. Member records continue below the fold in the intended mobile list treatment.

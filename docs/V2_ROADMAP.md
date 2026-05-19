# seriesbuilder v2 roadmap

## Goal

Preserve the current campaign automation behavior and evolve it into a more reliable v2 workflow.

## Known v1 behavior from prior work

The previous workflow focused on Meta/Facebook campaign UI automation around creative settings and image ads:

1. Wait for the creative settings button using the class group:
   `x78zum5 xdt5ytf x2lwn1j xeuugli xkh2ocl`
2. Click into the creative settings area only after it is confirmed visible.
3. Wait for the image ad wrapper using the class group:
   `x6s0dn4 x1q0g3np xozqiw3 x2lwn1j x1iyjqo2 xs83m0k x1xsc7gk x78zum5 xeuugli`
4. Click the `이미지 광고` option using the class group:
   `x1vvvo52 x1fvot60 xo1l8bm xxio538 xbsr9hj xq9mrsl x1mzt3pk x1vvkbs x13faqbe xeuugli x1iyjqo2`
5. Verify entry into the next surface by waiting for:
   `span[data-surface-wrapper="1"]`

## v2 upgrade direction

- Split selectors into a dedicated selector registry.
- Add step-by-step logging with screenshots on failure.
- Add retry helpers that wait, verify, then click.
- Add a dry-run mode that checks UI state without mutating campaign settings.
- Add a recovery path when Facebook/Meta generated class names change.
- Add Playwright tests around selector and retry utilities where possible.

## Suggested implementation phases

1. Restore or recreate the existing `src/open-campaign.js` source.
2. Extract common wait/click/verify behavior into `src/lib/ui-step.js`.
3. Move selector groups into `src/selectors/meta-campaign.js`.
4. Add a v2 runner entrypoint in `src/open-campaign-v2.js`.
5. Add debug artifacts under `debug/` and keep them ignored by git.


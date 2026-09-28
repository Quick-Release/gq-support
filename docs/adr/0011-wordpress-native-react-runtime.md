---
status: accepted
---

# Use WordPress's React runtime for the Reporter app

The Reporter app uses WordPress's React integration (`@wordpress/element`) and REST client (`@wordpress/api-fetch`), with React hooks for its small amount of request and view state; TanStack Query and `@wordpress/data` are deferred because the MVP uses manual refresh and does not need a shared or background query cache. Build with `@wordpress/scripts` and dependency extraction so PHP has an explicit WordPress dependency manifest. Use classic JSX so the manifest needs only `wp-element`; WordPress 6.5 does not register the `react-jsx-runtime` handle. Keep the launcher vanilla so the React runtime and app load only after an explicit open. The Reporter launcher remains separate from the operator Support setup page. This favors WordPress-owned runtime and REST conventions while avoiding an unnecessary second React runtime and query-cache lifecycle.

The on-demand loader must load external WordPress dependencies in the right order, show a retryable error if loading fails, and keep plugin-owned requests stopped while closed. Preserve an in-progress draft for the current page session; clear Reporter-specific in-memory state when identity or capabilities change. No comparative prototype or performance benchmark is required: WordPress-native conventions take priority over a measured bundle-size advantage. Validate that the externalized runtime and JSX dependencies work at the declared WordPress 6.5 minimum, and verify lazy-load failure paths under issue #5.

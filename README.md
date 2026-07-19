# our-providers

Our own streaming providers for the [Nuvio](https://nuvio.app) app.

## Providers

- **moviesmod** — catalog + streams

## Use in Nuvio

Add this URL in Nuvio → Settings → Plugins → "Add from URL":

```
https://raw.githubusercontent.com/YOUR-USERNAME/our-providers/main/providers/moviesmod.js
```

> Replace `YOUR-USERNAME` with your GitHub username.

Nuvio will refetch the file automatically when you update it.

## Develop

Source lives in `src/`, the built output in `providers/`.

The `providers/` folder is **auto-built** by the GitHub Actions workflow
(`.github/workflows/build.yml`) — don't edit it by hand. Just edit files in
`src/` and push to `main`. The workflow rebuilds and commits the bundle
in ~30 seconds.

### Local build (optional)

```bash
npm install
npm run build          # build all
npm run build:provider moviesmod
```

## Project layout

```
src/<provider>/index.js          # source
src/<provider>/resolvers/*.js    # per-host stream resolvers
providers/<provider>.js          # bundled output (auto-generated)
.github/workflows/build.yml      # CI: rebuilds on push
build.js                         # esbuild bundler
manifest.json                    # provider registry
```

## Provider API

| Function              | Returns                                |
|-----------------------|----------------------------------------|
| `getCatalog()`        | `[{ id, title, filter }]`              |
| `getPosts(filter, page)` | `{ posts: [...], nextPage? }`        |
| `getMeta(postIdOrUrl)`     | `{ id, type, title, poster, ... }`     |
| `getStreams(postIdOrUrl)`  | `[{ title, url, quality, headers }]`   |

All async. Nuvio awaits them.

`postIdOrUrl` can be:
- base64 `postId`
- direct post URL
- IMDb id (for example `tt1234567` or `{ imdbId: "tt1234567" }`)
- TMDB id (for example `12345` or `{ tmdbId: "12345" }`)
- object containing `postId`, `id`, `url`, or `href`

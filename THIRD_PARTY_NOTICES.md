# Third-party notices

`tests/fixtures/phoenix2.html` is the public Phoenix 2 Pumbility HTML fixture from
[DrMurloc/PumpItUpScoreTracker](https://github.com/DrMurloc/PumpItUpScoreTracker/blob/main/ScoreTracker/ScoreTracker.Tests/ApprovalTests/PiuGameApi/Fixtures/GetPumbility_Phoenix2.html).
The upstream parser was consulted to verify current markup and field meanings.
The fixture is a public test sample, not the requesting user's account data.

Upstream license:

```text
MIT License

Copyright (c) 2022 DrMurloc

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Runtime dependencies retain their own licenses, provided in their npm packages:

- [`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas) — MIT
- [`cheerio`](https://github.com/cheeriojs/cheerio) — MIT
- [`playwright`](https://github.com/microsoft/playwright) — Apache-2.0
- [`qrcode`](https://github.com/soldair/node-qrcode) — MIT

The Best50 renderer and demo placeholder artwork are original code and procedural artwork.
Official PIU Grade and Plate PNGs are preserved without alteration in `assets/grades/`
and `assets/plates/` at the user's request. Their source URLs, dimensions and hashes
are recorded in `assets/manifest.json`. They remain the property of their respective
rights holders and are not covered by this project's MIT license. No maimai assets
are included. Official song images, when fetched at runtime, also belong to their
respective rights holders.

# DeepSeek model discovery

The [official September 10, 2026 release](https://deepseek.com/en/news/deepseek-v4-1-flash/)
names `deepseek-flash` as the API ID for **DeepSeek V4.1 Flash**, with native image
input. The provider now supports the Vision role and labels this model accordingly.

The hosted DeepSeek picker includes this documented model before the first fetch,
with an old cache, and when discovery fails. Live API results are still fetched
and retained; discovery errors are still displayed. A documented suggestion does
not make the connection test pass. The picker distinguishes a model not returned
by the current listing in its description.

Saved model selections and cached API data are not rewritten. Custom DeepSeek
endpoints and other providers are not supplemented with this hosted model ID.
Additional/legacy models remain available when returned by the API; an unreleased
Pro version is not invented or automatically selected.

`node --test scripts/deepseek-models.test.cjs` exercises the production registry
with mocked HTTP responses and a real settings store. No paid inference call or
authenticated DeepSeek request is made by these tests.

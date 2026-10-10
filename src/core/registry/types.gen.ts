// Generated from registry/schema.json by `npm run gen:types`. Do not edit; CI fails if it is stale.

export type Slug = string;
/**
 * Where a model is served. A model router (OpenRouter, the Vercel AI Gateway) isn't a platform: its `<vendor>/<first-party ID>` slug gets the upstream model's dates.
 *
 * This interface was referenced by `Registry`'s JSON-Schema
 * via the `definition` "Platform".
 */
export type Platform =
  | 'openai'
  | 'anthropic'
  | 'gemini-api'
  | 'vertex'
  | 'bedrock'
  | 'azure-openai'
  | 'mistral'
  | 'deepseek';
/**
 * This interface was referenced by `Registry`'s JSON-Schema
 * via the `definition` "ModelStatus".
 */
export type ModelStatus = 'active' | 'legacy' | 'deprecated' | 'retired' | 'unverified';
/**
 * A calendar date in UTC, formatted YYYY-MM-DD.
 *
 * This interface was referenced by `Registry`'s JSON-Schema
 * via the `definition` "IsoDate".
 */
export type IsoDate = string & { readonly __brand: 'IsoDate' };
/**
 * This interface was referenced by `Registry`'s JSON-Schema
 * via the `definition` "DateQualifier".
 */
export type DateQualifier = 'exact' | 'no_earlier_than' | 'approximate';
/**
 * `<provider>/<slug>`: a record in registry/sources.yaml and the snapshot registry/snapshots/<provider>/<slug>.txt.
 *
 * This interface was referenced by `Registry`'s JSON-Schema
 * via the `definition` "SourceId".
 */
export type SourceId = string;
export type HttpsUrl = string;
/**
 * This interface was referenced by `Registry`'s JSON-Schema
 * via the `definition` "Slug".
 */
export type Slug1 = string;
/**
 * This interface was referenced by `Registry`'s JSON-Schema
 * via the `definition` "HttpsUrl".
 */
export type HttpsUrl1 = string;
export type HttpsUrl2 = string;
/**
 * The machine-readable variant of the page to fetch.
 *
 * This interface was referenced by `Registry`'s JSON-Schema
 * via the `definition` "SourceFetch".
 */
export type SourceFetch =
  | {
      kind: 'url';
      url: HttpsUrl1;
      format: 'markdown' | 'html' | 'text';
      accept?: string;
    }
  | {
      kind: 'github-file';
      repo: string;
      ref: string;
      path: string;
    }
  | {
      kind: 'github-dir';
      repo: string;
      ref: string;
      path: string;
      /**
       * File-name suffix, e.g. `.ts`. Files are read as text and never executed.
       */
      include: string;
      exclude?: string[];
    };
export type Slug2 = string;

/**
 * registry/models.yaml. The $defs also describe registry/sources.yaml (SourcesFile) and registry/formats.yaml (PlatformFormats). docs/registry.md has the rules for each field.
 */
export interface Registry {
  schema_version: 1;
  /**
   * Increases by one with every change to the models list.
   */
  registry_version: number;
  /**
   * When the file was last written, in UTC.
   */
  generated_at: string;
  models: RegistryEntry[];
}
/**
 * This interface was referenced by `Registry`'s JSON-Schema
 * via the `definition` "RegistryEntry".
 */
export interface RegistryEntry {
  /**
   * `platform:model_id[@version][#regions]`, computed by the validator from the other fields; never chosen by hand.
   */
  id: string;
  provider: Slug;
  platform: Platform;
  /**
   * The ID as it is written in code.
   */
  model_id: string;
  /**
   * The model version. Required for azure-openai, null elsewhere.
   */
  version: string | null;
  /**
   * Region scope: the regions these dates apply to, sorted. Absent or null means every region that no sibling entry lists.
   */
  regions?: string[] | null;
  /**
   * Other IDs that name exactly this entry. Floating aliases are separate entries.
   */
  aliases: string[];
  status: ModelStatus;
  deprecation_date: IsoDate | null;
  retirement_date: IsoDate | null;
  retirement_date_qualifier: DateQualifier;
  /**
   * Only replacements the source names.
   */
  recommended_replacements: Replacement[];
  /**
   * True only if the provider explicitly says the replacement is a drop-in.
   */
  drop_in: boolean;
  source: SourceId;
  source_url: HttpsUrl;
  /**
   * Verbatim text from the normalized snapshot of `source` that contains the model ID, the dates and the replacements. Null only for `unverified` entries without dates.
   */
  source_excerpt: string | null;
  verified_on: IsoDate;
  notes: string | null;
}
/**
 * This interface was referenced by `Registry`'s JSON-Schema
 * via the `definition` "Replacement".
 */
export interface Replacement {
  model_id: string;
  platform: Platform;
}
/**
 * registry/sources.yaml: where each provider publishes its lifecycle data.
 *
 * This interface was referenced by `Registry`'s JSON-Schema
 * via the `definition` "SourcesFile".
 */
export interface SourcesFile {
  schema_version: 1;
  /**
   * Source provider (the platform owner) → its allowlist.
   */
  providers: {
    [k: string]: ProviderAllowlist;
  };
  sources: Source[];
}
/**
 * This interface was referenced by `Registry`'s JSON-Schema
 * via the `definition` "ProviderAllowlist".
 */
export interface ProviderAllowlist {
  /**
   * URL prefixes (scheme, host and path) that source and fetch URLs must start with. A prefix ends at a `/` or matches the whole path.
   *
   * @minItems 1
   */
  allow: HttpsUrl1[];
}
/**
 * This interface was referenced by `Registry`'s JSON-Schema
 * via the `definition` "Source".
 */
export interface Source {
  id: SourceId;
  provider: Platform;
  /**
   * The platforms whose entries this page may support.
   *
   * @minItems 1
   */
  platforms: Platform[];
  url: HttpsUrl2;
  fetch: SourceFetch;
  /**
   * Text the normalized page must contain; catches soft 404s and redirects to a home page.
   */
  expect?: string;
  /**
   * A date qualifier the page states once for all of its dates, with the sentence that says so. Entries from this source may use the qualifier without their own excerpt saying it.
   */
  page_qualifier?: {
    qualifier: DateQualifier;
    excerpt: string;
  };
  /**
   * For a page about specific models only, such as a model card: their IDs, each of which must appear on the page. Excerpts from this page needn't repeat the model ID.
   *
   * @minItems 1
   */
  models?: string[];
  /**
   * An HTML page whose table-row classes carry state the fetched variant lacks (the Gemini API page marks shut-down models only with `row-gray`). The snapshot's .meta.json records the first cell of every row with one of these classes.
   */
  markup?: {
    url: HttpsUrl1;
    /**
     * @minItems 1
     */
    row_classes: string[];
  };
  parser: Slug2;
  notes?: string;
}
/**
 * A service that serves `<vendor>/<id>` through any provider that still has the model.
 *
 * This interface was referenced by `Registry`'s JSON-Schema
 * via the `definition` "ModelRouter".
 */
export interface ModelRouter {
  /**
   * The router's vendor slug → the first-party platforms whose IDs its slugs reuse.
   */
  vendors: {
    /**
     * @minItems 1
     */
    [k: string]: Platform[];
  };
}
/**
 * registry/formats.yaml: ID-format data kept out of code because providers add to it.
 *
 * This interface was referenced by `Registry`'s JSON-Schema
 * via the `definition` "PlatformFormats".
 */
export interface PlatformFormats {
  bedrock: {
    /**
     * Cross-region inference-profile prefixes, without the trailing dot.
     *
     * @minItems 1
     */
    geo_prefixes: string[];
    /**
     * ARN partitions, e.g. `aws`, `aws-us-gov`.
     *
     * @minItems 1
     */
    arn_partitions: string[];
  };
  openrouter: ModelRouter;
  vercel_ai_gateway?: ModelRouter;
  /**
   * A library's prefix before a model ID (`gemini/`, `anthropic:`) → the platforms the ID is checked on.
   */
  prefixes?: {
    /**
     * @minItems 1
     */
    [k: string]: Platform[];
  };
}

// Types mirroring the barakoCMS API surface. Hand-written for v0.1; a future version may generate
// these from the API's OpenAPI document so they can't drift.

/** Content lifecycle status. The API sends and accepts these names. */
export enum ContentStatus {
  Draft = "Draft",
  Published = "Published",
  Archived = "Archived",
  Scheduled = "Scheduled",
}

/** How visible a field or entry is. The API sends and accepts these names. */
export enum SensitivityLevel {
  Public = "Public",
  Sensitive = "Sensitive",
  Hidden = "Hidden",
  Members = "Members",
}

/** How a field value is masked for callers who may not read it in full. */
export enum FieldMask {
  Default = "Default",
  Remove = "Remove",
  Redact = "Redact",
  Last4 = "Last4",
}

/** A single content entry. `data` is the typed-per-content-type field bag. */
export interface Content {
  id: string;
  contentType: string;
  data: Record<string, unknown>;
  status: ContentStatus;
  version: number;
  sensitivity?: SensitivityLevel;
  createdAt?: string;
  updatedAt?: string;
}

/** A page of results from a list endpoint. */
export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface FieldDefinition {
  name: string;
  displayName: string;
  type: string;
  isRequired: boolean;
  defaultValue?: unknown;
  validationRules?: Record<string, unknown>;
  sensitivity?: SensitivityLevel;
  visibleToRoles?: string[];
  mask?: FieldMask;
}

export interface ContentTypeDefinition {
  id?: string;
  name: string;
  displayName: string;
  description?: string;
  fields: FieldDefinition[];
  createdAt?: string;
  updatedAt?: string;
}

/** The token pair returned by login / refresh / switch-tenant. */
export interface AuthTokens {
  token: string;
  expiry: string;
  refreshToken: string;
  refreshTokenExpiry: string;
  /** True when the password was right but the device needs approval: no tokens issued, an OTP was
   *  emailed. Only appears on login for device-trust deployments. */
  deviceApprovalRequired?: boolean;
}

export interface TenantSummary {
  slug: string;
  name: string;
  logoUrl?: string | null;
  branding?: Record<string, string>;
}

/** One field a write would change. Names match the server's FieldDiff. */
export interface FieldDiff {
  field: string;
  /** What it holds now, or null when it is new. */
  from?: unknown;
  /** What it would hold, or null when the write leaves it out. */
  to?: unknown;
}

/** The answer to a dry-run create or update: nothing was stored. */
export interface DryRunResult {
  dryRun: true;
  changes: FieldDiff[];
  id?: string;
  version?: number;
}

/** One field added to a content type (POST /api/content-types/{name}/fields). Only what a caller
 *  needs to add a plain field. The server checks every rule. */
export interface AddFieldInput {
  fieldName: string;
  /** Any name the server's field type registry accepts, such as `text`, `int` or `choice`. */
  type: string;
  displayName?: string;
  isRequired?: boolean;
  defaultValue?: unknown;
  /** Required for a `reference`. */
  referenceType?: string;
  /** Required for a `choice`. */
  options?: Array<{ value: string; label?: string }>;
  multiple?: boolean;
  /** For an `array`, the type every item is. */
  itemType?: string;
}

/** The answer to an add-field call. */
export interface AddFieldResult {
  contentType: string;
  /** The name of the field this call added. */
  added: string;
  /** Every field the type has now, in order. */
  fields: string[];
}

/** A field as a content reader sees it (GET /api/contents/types/{name}). */
export interface ReadableField {
  name: string;
  type: string;
  isRequired: boolean;
  validationRules: Record<string, unknown>;
  options?: unknown;
  multiple: boolean;
  itemType?: string | null;
  referenceType?: string | null;
  defaultValue?: unknown;
  jsonSchema?: unknown;
  currency?: string | null;
  scale?: number | null;
  computed?: unknown;
  /** Where the block schema of a blocks field is served. */
  blockSchema?: string | null;
}

export interface ReadableContentType {
  name: string;
  displayName: string;
  description: string;
  isSingleton: boolean;
  fields: ReadableField[];
  lifecycle?: unknown;
  uniqueness?: unknown;
}

export interface CreateContentInput {
  contentType: string;
  data: Record<string, unknown>;
  status?: ContentStatus;
  sensitivity?: SensitivityLevel;
}

export interface UpdateContentInput {
  data: Record<string, unknown>;
  status?: ContentStatus;
}

export interface ListContentQuery {
  contentType?: string;
  page?: number;
  pageSize?: number;
  status?: ContentStatus;
  /** Text search across entry values. */
  search?: string;
}

export interface ContentVersion {
  version: number;
  status: ContentStatus;
  updatedAt?: string;
  data?: Record<string, unknown>;
}

// --- Public delivery (anonymous, published-only) -------------------------------

/** A published entry from the public delivery API. Only public fields are present. */
export interface PublicContent {
  id: string;
  contentType: string;
  slug?: string | null;
  data: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface MenuItem {
  label: string;
  url: string;
  openInNewTab?: boolean;
  children?: MenuItem[];
}

/** A navigation menu from the public delivery API. */
export interface PublicMenu {
  slug: string;
  name: string;
  items: MenuItem[];
}

/**
 * Firestore REST 클라이언트.
 *
 * Worker 에서는 firebase-admin 을 쓸 수 없다 (Node 전용 crypto/gRPC 의존).
 * 그래서 서비스 계정 키로 JWT 를 WebCrypto 로 직접 서명해 access token 을 받고,
 * Firestore REST API 를 호출한다.
 */

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

/** Firestore 의 Value 표현 */
export type FsValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { timestampValue: string }
  | { nullValue: null }
  | { arrayValue: { values?: FsValue[] } }
  | { mapValue: { fields?: Record<string, FsValue> } };

export interface FsDocument {
  name?: string;
  fields?: Record<string, FsValue>;
  createTime?: string;
  updateTime?: string;
}

/** JS 값 → Firestore Value */
export function toFs(value: unknown): FsValue {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFs) } };
  }
  if (typeof value === "object") {
    const fields: Record<string, FsValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      fields[k] = toFs(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

/** Firestore Value → JS 값 */
export function fromFs(value: FsValue | undefined): unknown {
  if (!value) return undefined;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("nullValue" in value) return null;
  if ("arrayValue" in value) return (value.arrayValue.values ?? []).map(fromFs);
  if ("mapValue" in value) return fieldsToObject(value.mapValue.fields);
  return undefined;
}

export function fieldsToObject(
  fields: Record<string, FsValue> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields ?? {})) out[k] = fromFs(v);
  return out;
}

export function objectToFields(obj: Record<string, unknown>): Record<string, FsValue> {
  const fields: Record<string, FsValue> = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toFs(v);
  return fields;
}

/** 문서 리소스 이름에서 문서 ID 만 뽑는다 */
export function docId(name: string | undefined): string {
  if (!name) return "";
  const parts = name.split("/");
  return parts[parts.length - 1];
}

function base64url(input: ArrayBuffer | string): string {
  let bytes: Uint8Array;
  if (typeof input === "string") {
    bytes = new TextEncoder().encode(input);
  } else {
    bytes = new Uint8Array(input);
  }
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PEM (PKCS#8) → CryptoKey */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const raw = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    raw.buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** access token 캐시 — isolate 단위로만 살아있으면 충분하다 */
let tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  // 만료 60초 전에는 새로 받는다
  if (tokenCache && tokenCache.expiresAt - 60 > now) return tokenCache.token;

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/datastore",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const key = await importPrivateKey(sa.private_key);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  const jwt = `${signingInput}.${base64url(sig)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(`토큰 발급 실패 (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: data.access_token, expiresAt: now + data.expires_in };
  return data.access_token;
}

/**
 * 서비스 계정 값을 JSON 문자열로 정규화한다.
 *
 * 환경/파서에 따라 값이 이런 형태로 들어올 수 있다:
 *  - 그대로의 JSON
 *  - 작은/큰따옴표로 감싸진 JSON (일부 dotenv 파서가 따옴표를 벗기지 않는다)
 *  - base64 로 인코딩된 JSON (한 줄로 넣기 편해서 쓰는 방식)
 */
export function normalizeServiceAccount(raw: string): string {
  let value = (raw ?? "").trim();

  // 감싼 따옴표가 있으면 벗긴다
  const first = value[0];
  if ((first === "'" || first === '"') && value[value.length - 1] === first) {
    value = value.slice(1, -1).trim();
  }

  if (value.startsWith("{")) return value;

  // JSON 이 아니면 base64 로 간주하고 디코딩을 시도한다
  try {
    const decoded = atob(value.replace(/\s+/g, ""));
    if (decoded.trim().startsWith("{")) return decoded.trim();
  } catch {
    // base64 도 아니면 아래에서 원본을 그대로 넘겨 JSON.parse 가 실패하게 둔다
  }
  return value;
}

export interface FirestoreConfig {
  projectId: string;
  database: string;
  serviceAccountJson: string;
  /**
   * 컬렉션 이름 앞에 붙일 접두사. 예: "dev_"
   * 같은 프로젝트 안에서 개발/운영 데이터를 섞이지 않게 나누는 데 쓴다.
   * (별도 데이터베이스 생성 권한이 없어도 되는 방식)
   */
  collectionPrefix?: string;
}

export class Firestore {
  private sa: ServiceAccount;
  private base: string;
  private prefix: string;

  constructor(cfg: FirestoreConfig) {
    let parsed: ServiceAccount;
    try {
      parsed = JSON.parse(normalizeServiceAccount(cfg.serviceAccountJson)) as ServiceAccount;
    } catch {
      // 키 내용은 절대 노출하지 않고, 진단에 필요한 형태 정보만 남긴다
      const raw = cfg.serviceAccountJson ?? "";
      throw new Error(
        `GCP_SERVICE_ACCOUNT 시크릿이 올바른 JSON 이 아니다 ` +
          `(길이 ${raw.length}, 시작 문자 ${JSON.stringify(raw.slice(0, 1))}, ` +
          `끝 문자 ${JSON.stringify(raw.slice(-1))})`,
      );
    }
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error("서비스 계정 JSON 에 client_email / private_key 가 없다");
    }
    this.sa = parsed;
    const project = cfg.projectId || parsed.project_id;
    const db = cfg.database || "(default)";
    this.base = `https://firestore.googleapis.com/v1/projects/${project}/databases/${encodeURIComponent(db)}/documents`;
    this.prefix = cfg.collectionPrefix ?? "";
  }

  /** 접두사가 붙은 실제 컬렉션 이름 */
  collection(name: string): string {
    return this.prefix + name;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | string[]>,
  ): Promise<any> {
    const token = await getAccessToken(this.sa);
    const url = new URL(path.startsWith("http") ? path : this.base + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (Array.isArray(v)) for (const one of v) url.searchParams.append(k, one);
      else url.searchParams.set(k, v);
    }
    const res = await fetch(url.toString(), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Firestore ${method} ${path} 실패 (${res.status}): ${await res.text()}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  /** 문서 하나 읽기. 없으면 null */
  async get(collection: string, id: string): Promise<Record<string, unknown> | null> {
    const doc = (await this.request(
      "GET",
      `/${this.collection(collection)}/${encodeURIComponent(id)}`,
    )) as FsDocument | null;
    if (!doc) return null;
    return { id: docId(doc.name), ...fieldsToObject(doc.fields) };
  }

  /** ID 를 지정해 문서 생성 (있으면 덮어쓴다) */
  async set(collection: string, id: string, data: Record<string, unknown>): Promise<void> {
    // PATCH + updateMask 없이 보내면 전체 덮어쓰기가 된다
    await this.request("PATCH", `/${this.collection(collection)}/${encodeURIComponent(id)}`, {
      fields: objectToFields(data),
    });
  }

  /** 일부 필드만 수정 */
  async update(collection: string, id: string, data: Record<string, unknown>): Promise<void> {
    await this.request(
      "PATCH",
      `/${this.collection(collection)}/${encodeURIComponent(id)}`,
      { fields: objectToFields(data) },
      { "updateMask.fieldPaths": Object.keys(data) },
    );
  }

  async delete(collection: string, id: string): Promise<void> {
    await this.request("DELETE", `/${this.collection(collection)}/${encodeURIComponent(id)}`);
  }

  /**
   * structuredQuery 실행.
   * where 는 [필드, 연산자, 값] 배열로 받는다.
   */
  async query(
    collection: string,
    opts: {
      where?: Array<[string, string, unknown]>;
      orderBy?: Array<[string, "ASCENDING" | "DESCENDING"]>;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const filters = (opts.where ?? []).map(([field, op, value]) => ({
      fieldFilter: { field: { fieldPath: field }, op, value: toFs(value) },
    }));

    const structuredQuery: Record<string, unknown> = {
      from: [{ collectionId: this.collection(collection) }],
    };
    if (filters.length === 1) {
      structuredQuery.where = filters[0];
    } else if (filters.length > 1) {
      structuredQuery.where = { compositeFilter: { op: "AND", filters } };
    }
    if (opts.orderBy?.length) {
      structuredQuery.orderBy = opts.orderBy.map(([field, direction]) => ({
        field: { fieldPath: field },
        direction,
      }));
    }
    if (opts.limit !== undefined) structuredQuery.limit = opts.limit;
    if (opts.offset !== undefined) structuredQuery.offset = opts.offset;

    const rows = (await this.request("POST", ":runQuery", { structuredQuery })) as
      | Array<{ document?: FsDocument }>
      | null;
    if (!rows) return [];
    return rows
      .filter((r) => r.document)
      .map((r) => ({ id: docId(r.document!.name), ...fieldsToObject(r.document!.fields) }));
  }

  /**
   * 집계 쿼리 (COUNT / SUM).
   * 전체 문서를 가져와 세면 메일이 늘어날수록 느려지고 메모리도 위험하다.
   */
  async aggregate(
    collection: string,
    opts: {
      where?: Array<[string, string, unknown]>;
      count?: boolean;
      sumField?: string;
    },
  ): Promise<{ count: number; sum: number }> {
    const filters = (opts.where ?? []).map(([field, op, value]) => ({
      fieldFilter: { field: { fieldPath: field }, op, value: toFs(value) },
    }));

    const structuredQuery: Record<string, unknown> = {
      from: [{ collectionId: this.collection(collection) }],
    };
    if (filters.length === 1) structuredQuery.where = filters[0];
    else if (filters.length > 1) {
      structuredQuery.where = { compositeFilter: { op: "AND", filters } };
    }

    const aggregations: Array<Record<string, unknown>> = [];
    if (opts.count !== false) aggregations.push({ alias: "c", count: {} });
    if (opts.sumField) {
      aggregations.push({ alias: "s", sum: { field: { fieldPath: opts.sumField } } });
    }

    const res = (await this.request("POST", ":runAggregationQuery", {
      structuredAggregationQuery: { structuredQuery, aggregations },
    })) as Array<{ result?: { aggregateFields?: Record<string, FsValue> } }> | null;

    const fields = res?.find((r) => r.result)?.result?.aggregateFields ?? {};
    return {
      count: Number(fromFs(fields.c) ?? 0),
      sum: Number(fromFs(fields.s) ?? 0),
    };
  }

  /** 컬렉션 전체를 가볍게 나열 */
  async list(collection: string, pageSize = 300): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let pageToken: string | undefined;
    do {
      const query: Record<string, string> = { pageSize: String(pageSize) };
      if (pageToken) query.pageToken = pageToken;
      const res = (await this.request("GET", `/${this.collection(collection)}`, undefined, query)) as
        | { documents?: FsDocument[]; nextPageToken?: string }
        | null;
      if (!res) break;
      for (const doc of res.documents ?? []) {
        out.push({ id: docId(doc.name), ...fieldsToObject(doc.fields) });
      }
      pageToken = res.nextPageToken;
    } while (pageToken);
    return out;
  }
}

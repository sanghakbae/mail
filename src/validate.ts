/** 입력값 검증 — 외부 의존이 없어 단독으로 테스트할 수 있다. */

/**
 * Firestore 문서 ID 로 쓸 수 있는 값인지 검사한다.
 * 규칙을 어기면 Firestore 가 400 을 내므로, 미리 걸러 500 대신 안내를 준다.
 */
export function validateDocId(id: string): string | null {
  if (id.length === 0) return "빈 값이다";
  if (id.length > 1500) return "너무 길다";
  if (id.includes("/")) return "슬래시를 쓸 수 없다";
  if (id === "." || id === "..") return "'.' 또는 '..' 는 쓸 수 없다";
  // __foo__ 형태는 Firestore 예약어다
  if (/^__.*__$/.test(id)) return "앞뒤로 밑줄 두 개(__)를 쓴 이름은 예약되어 있다";
  return null;
}

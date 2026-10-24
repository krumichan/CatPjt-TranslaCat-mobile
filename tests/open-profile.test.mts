import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, createApiClient } from "../src/api/client.ts";
import { parseMessage, parseOpenProfile } from "../src/domain/chat/contracts.ts";
import { profileImageUrl } from "../src/domain/chat/profile-image-url.ts";
import type { OpenProfile } from "../src/domain/chat/types.ts";
import { createOpenProfileController } from "../src/features/open-profile/controller.ts";
import { selectedProfileImage, PROFILE_IMAGE_MAX_BYTES } from "../src/features/open-profile/image-selection.ts";
import { createOpenProfileService, type OpenProfileService } from "../src/features/open-profile/service.ts";

const photo = selectedProfileImage({ uri: "file:///synthetic/photo.jpg", mimeType: "image/jpeg", size: 128, width: 64, height: 64 });
const original: OpenProfile = { openChatMemberId: "7", nickname: "방별 이름", memberCode: "OC-TEST", joinedAt: "2026-10-23T00:00:00Z", profileImageUrl: "https://fixture.invalid/old.jpg" };
const updated: OpenProfile = { ...original, profileImageUrl: "https://fixture.invalid/new.jpg" };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(overrides: Partial<OpenProfileService> = {}, picker: () => Promise<typeof photo | null> = async () => photo) {
  let active = true;
  let current = true;
  let uploads = 0;
  let removals = 0;
  let reads = 0;
  let changes = 0;
  let saves = 0;
  const timers = new Set<() => void>();
  const service: OpenProfileService = {
    read: async () => { reads++; return original; },
    upload: async () => { uploads++; return updated; },
    remove: async () => { removals++; return { ...original, profileImageUrl: null }; },
    ...overrides,
  };
  const controller = createOpenProfileController({ roomId: "1", service, pickImage: picker,
    isCurrent: () => current, isActive: () => active, onChange: () => { changes++; }, onSaved: () => { saves++; },
    schedule: work => { timers.add(work); return () => { timers.delete(work); }; },
  });
  return { controller, timers, service,
    setActive: (value: boolean) => { active = value; }, setCurrent: (value: boolean) => { current = value; },
    get uploads() { return uploads; }, get removals() { return removals; }, get reads() { return reads; },
    get changes() { return changes; }, get saves() { return saves; },
  };
}

test("사진 선택 취소는 현재 사진과 기존 초안을 보존한다", async () => {
  // 준비·실행
  let canceled = false;
  const f = fixture({}, async () => canceled ? null : photo);
  await f.controller.load();
  await f.controller.choose();
  canceled = true;
  await f.controller.choose();

  // 검증
  assert.deepEqual(f.controller.getState().profile, original);
  assert.deepEqual(f.controller.getState().draft, photo);
  assert.equal(f.uploads, 0);
});

test("OS 사진 선택 중 inactive 전환은 선택을 잃거나 서버 요청을 만들지 않는다", async () => {
  // 준비
  const picked = deferred<typeof photo | null>();
  const f = fixture({}, () => picked.promise);
  await f.controller.load();
  const selecting = f.controller.choose();

  // 실행: OS 선택기가 떠 있는 동안 앱 비활성화
  f.setActive(false);
  f.controller.suspend();
  picked.resolve(photo);
  await selecting;

  // 검증
  assert.deepEqual(f.controller.getState().draft, photo);
  assert.equal(f.controller.getState().pending, null);
  assert.equal(f.uploads, 0);
  await f.controller.save();
  assert.equal(f.uploads, 0);
  f.setActive(true);
  await f.controller.save();
  assert.equal(f.uploads, 1);
});

test("사진 저장은 새 참여 조회 후 한 번만 전송하고 성공 때만 초안을 지운다", async () => {
  const f = fixture();
  await f.controller.load();
  await f.controller.choose();
  await f.controller.save();
  assert.equal(f.reads, 2);
  assert.equal(f.uploads, 1);
  assert.equal(f.saves, 1);
  assert.deepEqual(f.controller.getState().profile, updated);
  assert.equal(f.controller.getState().draft, null);
  assert.equal(f.timers.size, 0);
});

test("동시 저장 클릭은 업로드 한 번으로 제한한다", async () => {
  const pending = deferred<OpenProfile>();
  let uploads = 0;
  const f = fixture({ upload: async () => { uploads++; return pending.promise; } });
  await f.controller.load();
  await f.controller.choose();
  const saving = f.controller.save();
  await settle();
  await f.controller.save();
  assert.equal(uploads, 1);
  pending.resolve(updated);
  await saving;
});

test("사진 선택 뒤 계정 전환·화면 정리 결과는 새 화면을 갱신하지 않는다", async () => {
  for (const kind of ["account", "dispose"] as const) {
    const selected = deferred<typeof photo | null>();
    const f = fixture({}, () => selected.promise);
    await f.controller.load();
    const choosing = f.controller.choose();
    const changes = f.changes;
    if (kind === "account") f.setCurrent(false);
    else f.controller.dispose();
    selected.resolve(photo);
    await choosing;
    assert.equal(f.changes, changes);
    assert.equal(f.uploads, 0);
  }
});

test("저장 전 멤버 변경은 사진 전송을 막는다", async () => {
  let changed = false;
  const f = fixture({ read: async () => changed ? { ...original, openChatMemberId: "8" } : original });
  await f.controller.load();
  await f.controller.choose();
  changed = true;
  await f.controller.save();
  assert.equal(f.uploads, 0);
  assert.equal(f.controller.getState().ready, false);
});

test("삭제 확인 뒤 사진이 바뀌면 새 사진을 삭제하지 않는다", async () => {
  const f = fixture({ read: async () => original });
  await f.controller.load();
  f.service.read = async () => updated;
  await f.controller.remove("7", original.profileImageUrl ?? null);
  assert.equal(f.removals, 0);
  assert.equal(f.controller.getState().ready, false);
});

test("삭제는 확인한 멤버와 사진이 일치할 때만 실행한다", async () => {
  const f = fixture();
  await f.controller.load();
  await f.controller.remove("8", original.profileImageUrl ?? null);
  assert.equal(f.removals, 0);
  await f.controller.remove("7", original.profileImageUrl ?? null);
  assert.equal(f.removals, 1);
  assert.equal(f.controller.getState().profile?.profileImageUrl, null);
});

for (const status of [400, 401, 403, 404, 413, 415]) {
  test(`명시적인 업로드 거절 ${status}는 자동 재전송이나 결과 불명으로 바꾸지 않는다`, async () => {
    let attempts = 0;
    const f = fixture({ upload: async () => { attempts++; throw new ApiError(status, `HTTP_${status}`); } });
    await f.controller.load();
    await f.controller.choose();
    await f.controller.save();
    assert.equal(attempts, 1);
    assert.equal(f.controller.getState().uncertain, null);
    assert.equal(f.saves, 0);
    assert.equal(f.timers.size, 0);
  });
}

test("업로드 응답 유실은 재조회·명시 확인까지 재전송을 막는다", async () => {
  let attempts = 0;
  const f = fixture({ upload: async () => { attempts++; throw new ApiError(0, "NETWORK_UNAVAILABLE"); } });
  await f.controller.load();
  await f.controller.choose();
  await f.controller.save();
  await f.controller.save();
  f.controller.acknowledge();
  assert.equal(attempts, 1);
  assert.equal(f.controller.getState().uncertain?.reviewed, false);
  f.service.read = async () => updated;
  await f.controller.load();
  assert.equal(f.controller.getState().uncertain?.reviewed, true);
  f.controller.acknowledge();
  assert.equal(f.controller.getState().uncertain, null);
  assert.equal(f.controller.getState().draft, null);
  assert.equal(attempts, 1);
});

test("업로드 중 백그라운드 전환은 늦은 성공을 무시하고 결과 불명으로 보존한다", async () => {
  const response = deferred<OpenProfile>();
  const f = fixture({ upload: async () => response.promise });
  await f.controller.load();
  await f.controller.choose();
  const saving = f.controller.save();
  await settle();
  f.setActive(false);
  f.controller.suspend();
  response.resolve(updated);
  await saving;
  assert.equal(f.controller.getState().uncertain?.reviewed, false);
  assert.deepEqual(f.controller.getState().profile, original);
  assert.equal(f.saves, 0);
});

test("저장 전 조회 timeout은 전송 불명으로 만들지 않고 늦은 조회를 무시한다", async () => {
  const read = deferred<OpenProfile>();
  const f = fixture();
  await f.controller.load();
  await f.controller.choose();
  f.service.read = async () => read.promise;
  const saving = f.controller.save();
  [...f.timers][0]();
  read.resolve(original);
  await saving;
  assert.equal(f.uploads, 0);
  assert.equal(f.controller.getState().uncertain, null);
  assert.equal(f.controller.getState().pending, null);
});

test("비활성화 직후 취소 effect보다 먼저 온 확정 성공은 초안을 지운다", async () => {
  const response = deferred<OpenProfile>();
  const f = fixture({ upload: async () => response.promise });
  await f.controller.load();
  await f.controller.choose();
  const saving = f.controller.save();
  await settle();
  f.setActive(false);
  response.resolve(updated);
  await saving;
  assert.deepEqual(f.controller.getState().profile, updated);
  assert.equal(f.controller.getState().draft, null);
  assert.equal(f.controller.getState().uncertain, null);
  assert.equal(f.saves, 0);
});

test("업로드 timeout과 늦은 성공은 초안·기존 사진을 성공으로 덮지 않는다", async () => {
  const response = deferred<OpenProfile>();
  const f = fixture({ upload: async () => response.promise });
  await f.controller.load();
  await f.controller.choose();
  const saving = f.controller.save();
  await settle();
  [...f.timers][0]();
  response.resolve(updated);
  await saving;
  assert.equal(f.controller.getState().uncertain?.reviewed, false);
  assert.deepEqual(f.controller.getState().draft, photo);
  assert.deepEqual(f.controller.getState().profile, original);
  assert.equal(f.saves, 0);
});

test("허용 사진은 5MB까지이며 원본 파일명 없이 고정 이름을 사용한다", () => {
  assert.equal(selectedProfileImage({ ...photo, size: PROFILE_IMAGE_MAX_BYTES }).fileName, "profile.jpg");
  for (const patch of [
    { size: 0 }, { size: NaN }, { size: PROFILE_IMAGE_MAX_BYTES + 1 }, { mimeType: "image/svg+xml" },
    { mimeType: "image/heic" }, { uri: "https://fixture.invalid/photo.jpg" }, { uri: "data:image/png;base64,AA==" }, { width: 0 },
  ]) assert.throws(() => selectedProfileImage({ ...photo, ...patch }));
});

test("프로필 URL은 공개 HTTPS만 받고 계정 정보·내부 파일 URL은 버린다", () => {
  for (const url of [null, "http://fixture.invalid/a.jpg", "file:///private/a.jpg", "data:image/svg+xml,x", "https://user:secret@fixture.invalid/a.jpg", "https://fixture.invalid/a#token"]) {
    assert.equal(profileImageUrl(url), null);
  }
  assert.equal(profileImageUrl("https://fixture.invalid/a.jpg?signature=synthetic"), "https://fixture.invalid/a.jpg?signature=synthetic");
  assert.equal(parseOpenProfile({ openChatMemberId: 7, nickname: "방별", memberCode: "OC-TEST", joinedAt: "now", profileImageUrl: "file:///private" }).profileImageUrl, null);
});

test("숨김·탈퇴 메시지는 방별 사진 URL을 노출하지 않는다", () => {
  const dto = { id: 1, chatRoomId: 1, senderUserId: 2, senderType: "USER", senderName: "원래 이름", messageType: "TEXT", content: "합성", status: "SENT",
    translations: [], createdAt: "now", updatedAt: "now", sender: { openChatMemberId: 7, nickname: "방별", memberCode: "OC-TEST", profileImageUrl: "https://fixture.invalid/photo.jpg" } };
  assert.equal(parseMessage({ ...dto, contentVisibility: "BLOCKED" }).sender, null);
  assert.equal(parseMessage({ ...dto, authorDeleted: true }).sender?.profileImageUrl, null);
  assert.equal(parseMessage(dto).sender?.profileImageUrl, dto.sender.profileImageUrl);
});

test("multipart는 JSON 변환·Content-Type 강제 없이 같은 인증·취소·리다이렉트 경계를 사용한다", async () => {
  // 준비
  let captured: RequestInit | undefined;
  const abort = new AbortController();
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array([255, 216, 255])], { type: "image/jpeg" }), "profile.jpg");
  const api = createApiClient({ baseUrl: "https://fixture.invalid/api/v1", accessToken: async () => "synthetic-token",
    fetcher: async (_url, options) => { captured = options; return Response.json({ body: { ok: true } }); } });

  // 실행·검증
  await api.request("/chat/open-rooms/1/me/profile-image", { method: "POST", formData: form, signal: abort.signal });
  assert.equal(captured?.body, form);
  assert.equal(new Headers(captured?.headers).get("Content-Type"), null);
  assert.equal(new Headers(captured?.headers).get("Authorization"), "Bearer synthetic-token");
  assert.equal(captured?.signal, abort.signal);
  assert.equal(captured?.redirect, "error");
  await assert.rejects(api.request("/chat/open-rooms/1/me/profile-image", { body: {}, formData: form }), { code: "INVALID_MULTIPART_BODY" });
});

test("사진 서비스는 공개 OPEN 내 프로필 경로만 사용하며 다른 멤버 응답을 거절한다", async () => {
  const calls: string[] = [];
  let wrongMember = false;
  const dto = { openChatMemberId: 7, nickname: "방별", memberCode: "OC-TEST", joinedAt: "now", active: true, profileImageUrl: "https://fixture.invalid/photo.jpg" };
  const api = createApiClient({ baseUrl: "https://fixture.invalid/api/v1", accessToken: async () => "synthetic-token",
    fetcher: async (input, options) => {
      const url = new URL(String(input));
      calls.push(`${options?.method} ${url.pathname}`);
      const body = url.pathname.endsWith("/chat/rooms/1") ? { id: 1, roomType: "OPEN", sourceType: "OPEN", name: "테스트", memberCount: 2, updatedAt: "now" }
        : url.pathname.endsWith("/open-rooms/1") ? { id: 1, status: "ACTIVE" }
          : { ...dto, openChatMemberId: wrongMember ? 8 : 7 };
      return Response.json({ body });
    } });
  const service = createOpenProfileService(api, image => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([255, 216, 255])]), image.fileName);
    return form;
  });
  const signal = new AbortController().signal;
  assert.equal((await service.read("1", signal)).openChatMemberId, "7");
  assert.equal((await service.upload("1", "7", photo, signal)).openChatMemberId, "7");
  wrongMember = true;
  await assert.rejects(service.remove("1", "7", signal));
  assert.deepEqual(calls, ["GET /api/v1/chat/rooms/1", "GET /api/v1/chat/open-rooms/1", "GET /api/v1/chat/open-rooms/1/me/profile",
    "POST /api/v1/chat/open-rooms/1/me/profile-image", "DELETE /api/v1/chat/open-rooms/1/me/profile-image"]);
});

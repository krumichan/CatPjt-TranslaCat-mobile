export type PushInstallation = { installationId: string; installationProof: string; generation: number };
export type InstallationStorage = { read(): Promise<string | null>; write(value: string): Promise<void> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function parseInstallation(raw: string): PushInstallation {
  // 손상된 기존 식별자를 조용히 새 것으로 교체하면 서버의 이전 binding이 남을 수 있다.
  let value: Partial<PushInstallation> | null = null;
  try { value = JSON.parse(raw) as Partial<PushInstallation>; } catch { /* 아래에서 거부한다. */ }
  if (!value || typeof value.installationId !== "string" || !UUID.test(value.installationId)
    || typeof value.installationProof !== "string" || !/^[0-9a-f]{64}$/.test(value.installationProof)
    || !Number.isSafeInteger(value.generation) || Number(value.generation) < 0) {
    throw new Error("PUSH_INSTALLATION_STORAGE_INVALID");
  }
  return value as PushInstallation;
}

export class InstallationIdentity {
  private value: PushInstallation | null = null;
  private queue: Promise<void> = Promise.resolve();
  private storage: InstallationStorage;
  private random: () => Promise<Omit<PushInstallation, "generation">>;

  constructor(storage: InstallationStorage, random: () => Promise<Omit<PushInstallation, "generation">>) {
    this.storage = storage;
    this.random = random;
  }

  next(): Promise<PushInstallation> {
    // 하나의 record와 쓰기 queue로 proof·식별자·세대가 따로 저장되는 중간 상태를 만들지 않는다.
    const operation = this.queue.then(async () => {
      if (!this.value) {
        const raw = await this.storage.read();
        this.value = raw === null ? parseInstallation(JSON.stringify({ ...await this.random(), generation: 0 })) : parseInstallation(raw);
      }
      if (this.value.generation >= Number.MAX_SAFE_INTEGER) throw new Error("PUSH_GENERATION_EXHAUSTED");
      const next = { ...this.value, generation: this.value.generation + 1 };
      await this.storage.write(JSON.stringify(next));
      this.value = next;
      return { ...next };
    });
    this.queue = operation.then(() => {}, () => {});
    return operation;
  }
}

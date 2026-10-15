import { STAGE_LABEL, type StageState, type V2Stage } from '../lib/v2';

const DEFAULT_ORDER: V2Stage[] = ['download', 'separate', 'beats', 'chords', 'align'];

function fmtEta(s: number | null) {
  if (s == null || !Number.isFinite(s)) return '';
  if (s < 60) return `約剩 ${Math.ceil(s)} 秒`;
  return `約剩 ${Math.floor(s / 60)} 分 ${Math.ceil(s % 60)} 秒`;
}

/** Five-stage progress (下載模型 / 分離人聲 / 偵測節拍 / 辨識和弦 / 對齊歌詞) with % and ETA. */
export function StagedProgress({
  stages,
  onCancel,
  running,
  order = DEFAULT_ORDER,
}: {
  order?: V2Stage[];
  stages: Partial<Record<V2Stage, StageState>>;
  onCancel?: () => void;
  running: boolean;
}) {
  return (
    <div className="stages" data-testid="staged-progress">
      {order.map((k) => {
        const s = stages[k];
        const status = s?.status ?? 'pending';
        const pct = Math.round((status === 'done' ? 1 : s?.progress ?? 0) * 100);
        let note = '';
        if (status === 'skipped') note = k === 'download' ? '已快取' : '略過';
        else if (status === 'done') note = '完成';
        else if (status === 'active') {
          note = `${pct}%`;
          if (s?.bytes?.total) note += ` · ${(s.bytes.loaded / 1e6).toFixed(1)} / ${(s.bytes.total / 1e6).toFixed(1)} MB`;
          const e = fmtEta(s?.etaSec ?? null);
          if (e) note += ` · ${e}`;
        }
        return (
          <div key={k} className={`stage stage-${status}`}>
            <div className="stage-head">
              <span>{STAGE_LABEL[k]}</span>
              <span className="stage-note">{note}</span>
            </div>
            <div className="progress" aria-hidden>
              <span style={{ width: `${status === 'skipped' ? 0 : pct}%` }} />
            </div>
          </div>
        );
      })}
      {running && onCancel && (
        <button type="button" className="btn btn-secondary" onClick={onCancel} data-testid="cancel-analysis">
          取消
        </button>
      )}
    </div>
  );
}

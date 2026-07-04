// Auto-generated 70s spectrogram loader styles + markup (see FetchingState.tsx).
export const LOADER_CSS = `
.cm-loader{
      --blue:#34D399; --mint:#86EFAC;
      --grad:linear-gradient(135deg,#10B981 0%,#34D399 48%,#86EFAC 100%);
      --ink:#E5F8EC; --dim:#8FB7A1;
      position:relative; display:flex; align-items:center; justify-content:center;
      min-height:460px; width:100%; box-sizing:border-box; padding:28px;
      font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",Inter,system-ui,sans-serif;
      -webkit-font-smoothing:antialiased; color:var(--ink);
    }
    .cm-loader *{box-sizing:border-box}

    .cm-card{
      position:relative; width:min(560px,94vw); padding:34px 34px 30px;
      border-radius:30px;
      background:
        radial-gradient(120% 140% at 18% 0%, rgba(52,211,153,.10), transparent 55%),
        radial-gradient(120% 140% at 90% 100%, rgba(134,239,172,.10), transparent 55%),
        linear-gradient(180deg, rgba(17,39,28,.78), rgba(12,31,22,.86));
      border:1px solid rgba(255,255,255,.08);
      box-shadow:
        0 30px 80px -28px rgba(0,0,0,.7),
        0 0 0 1px rgba(52,211,153,.05),
        inset 0 1px 0 rgba(255,255,255,.06);
      backdrop-filter:blur(22px) saturate(140%);
      -webkit-backdrop-filter:blur(22px) saturate(140%);
      overflow:hidden;
    }
    /* faint moving sheen across the glass */
    .cm-card::after{
      content:""; position:absolute; inset:0; border-radius:inherit; pointer-events:none;
      background:linear-gradient(115deg,transparent 30%,rgba(255,255,255,.05) 47%,transparent 64%);
      background-size:280% 100%; animation:cm-sheen 7s linear infinite; opacity:.7;
    }
    @keyframes cm-sheen{0%{background-position:140% 0}100%{background-position:-140% 0}}

    .cm-head{display:flex; align-items:baseline; justify-content:space-between; gap:14px; margin-bottom:18px}
    .cm-title{display:flex; align-items:center; gap:9px; font-size:13.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--dim); font-weight:600}
    .cm-dot{width:9px; height:9px; border-radius:50%; background:var(--grad); box-shadow:0 0 12px rgba(134,239,172,.8); animation:cm-pulse 1.6s ease-in-out infinite}
    @keyframes cm-pulse{0%,100%{transform:scale(1);opacity:.65}50%{transform:scale(1.35);opacity:1}}

    /* ---- Percentage ---- */
    .cm-pct{display:flex; align-items:flex-start; line-height:.9; font-weight:800; letter-spacing:-.03em}
    .cm-pct-num{
      font-size:64px;
      background:var(--grad); -webkit-background-clip:text; background-clip:text; color:transparent;
      font-variant-numeric:tabular-nums; filter:drop-shadow(0 4px 22px rgba(52,211,153,.28));
    }
    .cm-pct-sign{font-size:26px; margin-top:6px; margin-left:3px; color:var(--mint); font-weight:700; opacity:.9}

    /* ---- Spectrogram ---- */
    .cm-spec{
      position:relative; margin:20px 0 6px; height:188px; border-radius:18px; overflow:hidden;
      background:linear-gradient(180deg, rgba(10,27,19,.7), rgba(8,20,14,.92));
      border:1px solid rgba(255,255,255,.06);
      box-shadow:inset 0 0 40px rgba(0,0,0,.6);
    }
    .cm-grid{position:absolute; inset:0; display:flex; gap:2px; padding:8px}
    .cm-col{flex:1; display:flex; flex-direction:column-reverse; gap:2px}
    .cm-cell{
      flex:1; border-radius:2px; background:var(--mint);
      opacity:.05; transform:scaleY(.55); transform-origin:bottom;
      transition:opacity .12s linear, transform .12s linear, background-color .2s linear;
      will-change:opacity,transform;
    }
    /* scan / decode head */
    .cm-scan{
      position:absolute; top:0; bottom:0; width:64px; pointer-events:none;
      background:linear-gradient(90deg,transparent, rgba(52,211,153,.05) 40%, rgba(110,231,183,.16) 75%, rgba(167,243,208,.5));
      mix-blend-mode:screen; filter:blur(.3px);
    }
    .cm-scan::before{
      content:""; position:absolute; right:0; top:0; bottom:0; width:2px;
      background:linear-gradient(180deg,transparent,var(--mint),var(--blue),transparent);
      box-shadow:0 0 18px 3px rgba(110,231,183,.7);
    }
    /* baseline glow line */
    .cm-spec::after{
      content:""; position:absolute; left:0; right:0; bottom:0; height:30px; pointer-events:none;
      background:linear-gradient(0deg, rgba(134,239,172,.16), transparent);
    }

    /* ---- Crystallizing chord labels ---- */
    .cm-chords{position:absolute; inset:0; pointer-events:none}
    .cm-chord{
      position:absolute; transform:translate(-50%,-50%) scale(.82);
      font-weight:750; font-size:18px; letter-spacing:-.01em;
      color:#ECFDF3; padding:5px 11px; border-radius:11px;
      background:rgba(16,36,26,.55); border:1px solid rgba(110,231,183,.34);
      box-shadow:0 6px 20px -8px rgba(0,0,0,.7), inset 0 1px 0 rgba(255,255,255,.08);
      backdrop-filter:blur(3px); -webkit-backdrop-filter:blur(3px);
      opacity:0; filter:blur(7px);
      transition:opacity .5s ease, filter .5s ease, transform .5s cubic-bezier(.2,.9,.25,1.2);
      text-shadow:0 0 10px rgba(110,231,183,.35);
    }
    .cm-chord.lit{opacity:1; filter:blur(0); transform:translate(-50%,-50%) scale(1)}
    .cm-chord b{background:var(--grad); -webkit-background-clip:text; background-clip:text; color:transparent}

    /* ---- Status / bar ---- */
    .cm-foot{margin-top:18px}
    .cm-status{display:flex; align-items:center; gap:10px; height:22px; font-size:15px; color:var(--ink); font-weight:500}
    .cm-status .eq{display:inline-flex; gap:2.5px; align-items:flex-end; height:14px}
    .cm-status .eq i{width:3px; height:100%; border-radius:2px; background:var(--grad); animation:cm-eq 1s ease-in-out infinite}
    .cm-status .eq i:nth-child(2){animation-delay:.18s}
    .cm-status .eq i:nth-child(3){animation-delay:.36s}
    .cm-status .eq i:nth-child(4){animation-delay:.10s}
    @keyframes cm-eq{0%,100%{transform:scaleY(.3)}50%{transform:scaleY(1)}}
    .cm-words{position:relative; overflow:hidden; height:22px; flex:1}
    .cm-word{position:absolute; left:0; top:0; white-space:nowrap; transition:transform .5s cubic-bezier(.4,0,.2,1), opacity .5s}
    .cm-word.in{transform:translateY(0); opacity:1}
    .cm-word.up{transform:translateY(-115%); opacity:0}
    .cm-word.down{transform:translateY(115%); opacity:0}

    .cm-track{position:relative; margin-top:14px; height:7px; border-radius:99px; background:rgba(255,255,255,.07); overflow:hidden}
    .cm-fill{position:absolute; left:0; top:0; bottom:0; width:0%; border-radius:99px; background:var(--grad);
      box-shadow:0 0 16px rgba(52,211,153,.55); transition:width .25s cubic-bezier(.3,.8,.3,1)}
    .cm-fill::after{content:""; position:absolute; inset:0; background:linear-gradient(90deg,transparent,rgba(255,255,255,.45),transparent); background-size:200% 100%; animation:cm-shine 1.6s linear infinite}
    @keyframes cm-shine{0%{background-position:120% 0}100%{background-position:-120% 0}}

    .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);border:0}

    /* Honor reduced-motion: silence the looping decorative keyframes. */
    @media (prefers-reduced-motion: reduce){
      .cm-card::after, .cm-dot, .cm-status .eq i, .cm-fill::after, .cm-scan{ animation:none !important }
    }
`;

export const CARD_HTML = `
<div class="cm-card">
    <div class="cm-head">
      <div class="cm-title"><span class="cm-dot"></span>chordMatik · analyzing</div>
      <div class="cm-pct"><span class="cm-pct-num" id="cmNum">0</span><span class="cm-pct-sign">%</span></div>
    </div>

    <div class="cm-spec">
      <div class="cm-grid" id="cmGrid"></div>
      <div class="cm-chords" id="cmChords"></div>
      <div class="cm-scan" id="cmScan"></div>
    </div>

    <div class="cm-foot">
      <div class="cm-status">
        <span class="eq"><i></i><i></i><i></i><i></i></span>
        <span class="cm-words"><span class="cm-word in" id="cmWord">Getting the video…</span></span>
      </div>
      <div class="cm-track"><div class="cm-fill" id="cmFill"></div></div>
    </div>
  </div>
`;

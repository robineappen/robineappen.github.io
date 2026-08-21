(() => {
  const cfg = window.PREMIER_PICKS_CONFIG || {};
  const configured = cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes("YOUR_PROJECT")
    && cfg.SUPABASE_PUBLISHABLE_KEY && !cfg.SUPABASE_PUBLISHABLE_KEY.includes("YOUR_KEY");
  const sb = configured ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY) : null;

  let user = null, profile = null, currentMw = 1, fixtures = [], predictions = new Map(), confirmation = null;

  const $ = (id) => document.getElementById(id);
  const els = {
    fixtures:$("fixtures"), matchweek:$("matchweekSelect"), mwTitle:$("mwTitle"),
    prev:$("prevMw"), next:$("nextMw"), confirm:$("confirmBtn"), confirmTitle:$("confirmTitle"),
    confirmText:$("confirmText"), banner:$("statusBanner"), signIn:$("signInBtn"), signOut:$("signOutBtn"),
    accountName:$("accountName"), auth:$("authModal"), email:$("emailInput"), name:$("nameInput"),
    nameLabel:$("nameLabel"), send:$("sendMagicLink"), authMessage:$("authMessage"),
    toast:$("toast"), leaderboard:$("leaderboardRows")
  };

  for(let i=1;i<=38;i++){ const o=document.createElement("option"); o.value=i; o.textContent=`Matchweek ${i}`; els.matchweek.appendChild(o); }

  document.querySelectorAll(".nav-btn").forEach(b => b.addEventListener("click", () => switchView(b.dataset.view)));
  $("closeAuth").onclick=()=>els.auth.classList.add("hidden");
  els.signIn.onclick=()=>els.auth.classList.remove("hidden");
  els.signOut.onclick=async()=>{ if(sb) await sb.auth.signOut(); };
  els.matchweek.onchange=()=>{ currentMw=Number(els.matchweek.value); loadWeek(); };
  els.prev.onclick=()=>{ if(currentMw>1){ currentMw--; els.matchweek.value=currentMw; loadWeek(); }};
  els.next.onclick=()=>{ if(currentMw<38){ currentMw++; els.matchweek.value=currentMw; loadWeek(); }};
  els.confirm.onclick=confirmWeek;
  $("refreshLeaderboard").onclick=loadLeaderboard;
  els.send.onclick=sendMagicLink;

  function switchView(view){
    document.querySelectorAll(".nav-btn").forEach(x=>x.classList.toggle("active",x.dataset.view===view));
    ["predict","leaderboard","rules"].forEach(v=>$(`${v}View`).classList.toggle("hidden",v!==view));
    $("hero").classList.toggle("hidden",view!=="predict");
    if(view==="leaderboard") loadLeaderboard();
  }
  function toast(msg){ els.toast.textContent=msg; els.toast.classList.remove("hidden"); setTimeout(()=>els.toast.classList.add("hidden"),2800); }
  function configuredMessage(){
    els.fixtures.innerHTML=`<div class="empty-card"><strong>Almost ready.</strong><br><br>Add your Supabase URL and publishable key to <code>config.js</code>, then run <code>supabase.sql</code> in Supabase.</div>`;
  }

  async function sendMagicLink(){
    if(!sb){ els.authMessage.textContent="Configure Supabase in config.js first."; return; }
    const email=els.email.value.trim();
    if(!email){ els.authMessage.textContent="Enter your email first."; return; }
    els.send.disabled=true;
    const {error}=await sb.auth.signInWithOtp({email,options:{emailRedirectTo:location.origin+location.pathname}});
    els.send.disabled=false;
    els.authMessage.textContent=error?error.message:"Check your email for the sign-in link.";
  }

  async function ensureProfile(){
    if(!user) return;
    let {data}=await sb.from("profiles").select("id,display_name").eq("id",user.id).maybeSingle();
    if(data){ profile=data; return; }
    const fallback=(user.email||"Player").split("@")[0].slice(0,24);
    const name=prompt("Choose your leaderboard name:",fallback);
    if(!name) return;
    const ins=await sb.from("profiles").insert({id:user.id,display_name:name.trim().slice(0,24)}).select().single();
    if(ins.error){ toast(ins.error.message); return; }
    profile=ins.data;
  }

  async function refreshAuth(){
    if(!sb){ configuredMessage(); return; }
    const {data:{session}}=await sb.auth.getSession();
    user=session?.user||null;
    if(user) await ensureProfile();
    els.signIn.classList.toggle("hidden",!!user); els.signOut.classList.toggle("hidden",!user);
    els.accountName.classList.toggle("hidden",!user); els.accountName.textContent=profile?.display_name||user?.email||"";
    if(user){ els.auth.classList.add("hidden"); await loadWeek(); } else renderFixtures([]);
  }

  async function loadWeek(){
    els.mwTitle.textContent=`Matchweek ${currentMw}`;
    if(!sb || !user){ if(!configured) configuredMessage(); return; }
    els.fixtures.innerHTML=`<div class="empty-card">Loading Matchweek ${currentMw}…</div>`;
    const [fx,pr,cf]=await Promise.all([
      sb.from("fixtures").select("*").eq("matchweek",currentMw).order("kickoff"),
      sb.from("predictions").select("fixture_id,home_pred,away_pred").eq("user_id",user.id),
      sb.from("confirmations").select("*").eq("user_id",user.id).eq("matchweek",currentMw).maybeSingle()
    ]);
    if(fx.error){ els.fixtures.innerHTML=`<div class="empty-card">${escapeHtml(fx.error.message)}</div>`; return; }
    fixtures=fx.data||[]; predictions=new Map((pr.data||[]).map(x=>[String(x.fixture_id),x])); confirmation=cf.data||null;
    renderFixtures(fixtures); updateConfirmBar();
  }

  function renderFixtures(list){
    if(!user && configured){ els.fixtures.innerHTML=`<div class="empty-card">Sign in to make your predictions.</div>`; return; }
    if(!list.length){ els.fixtures.innerHTML=`<div class="empty-card">No fixtures loaded for Matchweek ${currentMw} yet.</div>`; updateConfirmBar(); return; }
    els.fixtures.innerHTML=list.map(f=>{
      const p=predictions.get(String(f.id))||{}, locked=!!confirmation, finished=f.status==="FINISHED"&&f.home_score!=null&&f.away_score!=null;
      const d=new Date(f.kickoff), date=isNaN(d)?f.kickoff:d.toLocaleString([], {weekday:"short",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});
      return `<article class="fixture-card">
        <button class="fixture-toggle" type="button">
          <div class="fixture-meta"><span>${escapeHtml(date)}</span><span>${escapeHtml(f.status||"SCHEDULED")}</span></div>
          <div class="teams"><div class="team">${escapeHtml(f.home_team)}<small>HOME</small></div><div class="versus">VS</div><div class="team away">${escapeHtml(f.away_team)}<small>AWAY</small></div></div>
          <div class="saved-summary">${p.home_pred!=null&&p.away_pred!=null?`Saved: ${p.home_pred}–${p.away_pred}`:`Click to predict`}</div>
        </button>
        <div class="fixture-editor">
          <div class="prediction-inputs">
            <input inputmode="numeric" min="0" max="20" type="number" data-fixture="${f.id}" data-side="home" value="${p.home_pred??""}" ${locked?"disabled":""}>
            <div class="dash">—</div>
            <input inputmode="numeric" min="0" max="20" type="number" data-fixture="${f.id}" data-side="away" value="${p.away_pred??""}" ${locked?"disabled":""}>
          </div>
          <button class="save-prediction primary-btn" type="button" ${locked?"disabled":""}>${locked?"Locked":"Save prediction"}</button>
          ${finished?`<div class="actual">Final: <strong>${f.home_score}–${f.away_score}</strong>${scorePoints(p,f)!==null?` · ${scorePoints(p,f)} pts`:""}</div>`:""}
        </div>
      </article>`;
    }).join("");
    els.fixtures.querySelectorAll(".fixture-toggle").forEach(b=>b.addEventListener("click",()=>b.closest(".fixture-card").classList.toggle("open")));
    els.fixtures.querySelectorAll(".save-prediction").forEach(b=>b.addEventListener("click",savePrediction));
  }

  async function savePrediction(e){
    if(!sb||!user||confirmation) return;
    const card=e.target.closest(".fixture-card");
    const inputs=[...card.querySelectorAll("input")], h=inputs[0].value, a=inputs[1].value;
    const id=String(inputs[0].dataset.fixture);
    if(h===""||a==="") return;
    const payload={user_id:user.id,fixture_id:Number(id),home_pred:Number(h),away_pred:Number(a),updated_at:new Date().toISOString()};
    const {error}=await sb.from("predictions").upsert(payload,{onConflict:"user_id,fixture_id"});
    if(error){ toast(error.message); return; }
    predictions.set(id,payload); card.querySelector(".saved-summary").textContent=`Saved: ${h}–${a}`; toast("Prediction saved ✓"); updateConfirmBar();
  }

  function updateConfirmBar(){
    const complete=fixtures.length>0&&fixtures.every(f=>{ const p=predictions.get(String(f.id)); return p&&p.home_pred!==null&&p.away_pred!==null; });
    if(confirmation){
      els.confirm.disabled=true; els.confirm.textContent="Locked ✓"; els.confirmTitle.textContent=`Matchweek ${currentMw} confirmed`;
      els.confirmText.textContent=`Locked ${new Date(confirmation.confirmed_at).toLocaleString()}. Your scorelines cannot be changed.`;
      els.banner.textContent="✓ Predictions confirmed and locked."; els.banner.classList.remove("hidden");
    } else {
      els.confirm.disabled=!complete; els.confirm.textContent="Confirm predictions"; els.confirmTitle.textContent=complete?"Ready to lock":"Predictions open";
      els.confirmText.textContent=complete?"Confirming will permanently lock this matchweek.":"Complete every match, then confirm to lock this matchweek.";
      els.banner.classList.add("hidden");
    }
  }

  async function confirmWeek(){
    if(!confirm(`Lock all Matchweek ${currentMw} predictions? You will not be able to edit them afterward.`)) return;
    els.confirm.disabled=true;
    const {error}=await sb.rpc("confirm_matchweek",{p_matchweek:currentMw});
    if(error){ toast(error.message); updateConfirmBar(); return; }
    toast(`Matchweek ${currentMw} locked ✓`); await loadWeek();
  }

  async function loadLeaderboard(){
    if(!sb){ els.leaderboard.innerHTML=`<div class="empty-card borderless">Configure Supabase first.</div>`; return; }
    const {data,error}=await sb.rpc("get_leaderboard");
    if(error){ els.leaderboard.innerHTML=`<div class="empty-card borderless">${escapeHtml(error.message)}</div>`; return; }
    if(!data?.length){ els.leaderboard.innerHTML=`<div class="empty-card borderless">No completed matches yet.</div>`; return; }
    els.leaderboard.innerHTML=data.map((r,i)=>`<div class="leader-row ${i<3?"top":""}">
      <span class="rank">${r.rank}</span><span class="player-cell">${escapeHtml(r.display_name)}<small>${r.matches_scored} scored matches</small></span>
      <span class="points">${r.total_points}</span><span>${r.exact_scores}</span><span>${r.correct_outcomes}</span>
    </div>`).join("");
  }

  function scorePoints(p,f){
    if(p.home_pred==null||p.away_pred==null||f.home_score==null||f.away_score==null) return null;
    if(Number(p.home_pred)===Number(f.home_score)&&Number(p.away_pred)===Number(f.away_score)) return 4;
    return Math.sign(Number(p.home_pred)-Number(p.away_pred))===Math.sign(Number(f.home_score)-Number(f.away_score))?3:0;
  }
  function escapeHtml(s){return String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));}

  if(sb) sb.auth.onAuthStateChange(()=>setTimeout(refreshAuth,0));
  refreshAuth();
})();
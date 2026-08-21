(() => {
  // Accept either config variable name so we never have that earlier problem again.
  const cfg =
    window.PREMIER_PICKS ||
    window.PREMIER_PICKS_CONFIG ||
    {};

  const configured =
    cfg.SUPABASE_URL &&
    !cfg.SUPABASE_URL.includes("YOUR_PROJECT") &&
    cfg.SUPABASE_PUBLISHABLE_KEY &&
    !cfg.SUPABASE_PUBLISHABLE_KEY.includes("YOUR_KEY");

  const sb = configured
    ? window.supabase.createClient(
        cfg.SUPABASE_URL,
        cfg.SUPABASE_PUBLISHABLE_KEY
      )
    : null;

  let user = null;
  let profile = null;
  let currentMw = 1;
  let fixtures = [];
  let predictions = new Map();
  let confirmation = null;

  const $ = (id) => document.getElementById(id);

  const els = {
    fixtures: $("fixtures"),
    matchweek: $("matchweekSelect"),
    mwTitle: $("mwTitle"),
    prev: $("prevMw"),
    next: $("nextMw"),
    confirm: $("confirmBtn"),
    confirmTitle: $("confirmTitle"),
    confirmText: $("confirmText"),
    banner: $("statusBanner"),

    signIn: $("signInBtn"),
    signOut: $("signOutBtn"),
    accountName: $("accountName"),

    auth: $("authModal"),
    email: $("emailInput"),
    send: $("sendMagicLink"),
    authMessage: $("authMessage"),

    toast: $("toast"),
    leaderboard: $("leaderboardRows")
  };

  // ----------------------------------------------------------
  // MATCHWEEK SELECTOR
  // ----------------------------------------------------------

  for (let i = 1; i <= 38; i++) {
    const option = document.createElement("option");
    option.value = i;
    option.textContent = `Matchweek ${i}`;
    els.matchweek.appendChild(option);
  }

  // ----------------------------------------------------------
  // NAVIGATION
  // ----------------------------------------------------------

  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.addEventListener("click", () => {
      switchView(button.dataset.view);
    });
  });

  function switchView(view) {
    document.querySelectorAll(".nav-btn").forEach((button) => {
      button.classList.toggle(
        "active",
        button.dataset.view === view
      );
    });

    ["predict", "leaderboard", "rules"].forEach((name) => {
      const section = $(`${name}View`);
      if (section) {
        section.classList.toggle("hidden", name !== view);
      }
    });

    const hero = $("hero");

    if (hero) {
      hero.classList.toggle("hidden", view !== "predict");
    }

    if (view === "leaderboard") {
      loadLeaderboard();
    }
  }

  // ----------------------------------------------------------
  // BUTTONS
  // ----------------------------------------------------------

  const closeAuth = $("closeAuth");

  if (closeAuth) {
    closeAuth.addEventListener("click", () => {
      els.auth.classList.add("hidden");
    });
  }

  els.signIn.addEventListener("click", () => {
    els.auth.classList.remove("hidden");
  });

  els.signOut.addEventListener("click", async () => {
    if (sb) {
      await sb.auth.signOut();
    }
  });

  els.matchweek.addEventListener("change", () => {
    currentMw = Number(els.matchweek.value);
    loadWeek();
  });

  els.prev.addEventListener("click", () => {
    if (currentMw > 1) {
      currentMw--;
      els.matchweek.value = currentMw;
      loadWeek();
    }
  });

  els.next.addEventListener("click", () => {
    if (currentMw < 38) {
      currentMw++;
      els.matchweek.value = currentMw;
      loadWeek();
    }
  });

  els.confirm.addEventListener("click", confirmWeek);

  const refreshLeaderboard = $("refreshLeaderboard");

  if (refreshLeaderboard) {
    refreshLeaderboard.addEventListener(
      "click",
      loadLeaderboard
    );
  }

  els.send.addEventListener("click", sendMagicLink);

  // ----------------------------------------------------------
  // HELPERS
  // ----------------------------------------------------------

  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.remove("hidden");

    setTimeout(() => {
      els.toast.classList.add("hidden");
    }, 2800);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;"
        })[character]
    );
  }

  function showNotConfigured() {
    els.fixtures.innerHTML = `
      <div class="empty-card">
        Configure Supabase in config.js first.
      </div>
    `;
  }

  // ----------------------------------------------------------
  // AUTHENTICATION
  // ----------------------------------------------------------

  async function sendMagicLink() {
    if (!sb) {
      els.authMessage.textContent =
        "Configure Supabase in config.js first.";
      return;
    }

    const email = els.email.value.trim();

    if (!email) {
      els.authMessage.textContent =
        "Enter your email first.";
      return;
    }

    els.send.disabled = true;

    const { error } = await sb.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo:
          "https://robineappen.github.io/premier-picks/"
      }
    });

    els.send.disabled = false;

    els.authMessage.textContent = error
      ? error.message
      : "Check your email for the sign-in link.";
  }

  async function ensureProfile() {
    if (!user) return;

    const result = await sb
      .from("profiles")
      .select("id,display_name")
      .eq("id", user.id)
      .maybeSingle();

    if (result.data) {
      profile = result.data;
      return;
    }

    const suggestedName = (user.email || "Player")
      .split("@")[0]
      .slice(0, 24);

    const name = prompt(
      "Choose your leaderboard name:",
      suggestedName
    );

    if (!name) return;

    const created = await sb
      .from("profiles")
      .insert({
        id: user.id,
        display_name: name.trim().slice(0, 24)
      })
      .select()
      .single();

    if (created.error) {
      toast(created.error.message);
      return;
    }

    profile = created.data;
  }

  async function refreshAuth() {
    if (!sb) {
      showNotConfigured();
      return;
    }

    const {
      data: { session }
    } = await sb.auth.getSession();

    user = session?.user || null;

    if (user) {
      await ensureProfile();
    }

    els.signIn.classList.toggle("hidden", !!user);
    els.signOut.classList.toggle("hidden", !user);
    els.accountName.classList.toggle("hidden", !user);

    els.accountName.textContent =
      profile?.display_name ||
      user?.email ||
      "";

    if (user) {
      els.auth.classList.add("hidden");
      await loadWeek();
    } else {
      renderFixtures([]);
    }
  }

  // ----------------------------------------------------------
  // LOAD MATCHWEEK
  // ----------------------------------------------------------

  async function loadWeek() {
    els.mwTitle.textContent =
      `Matchweek ${currentMw}`;

    if (!sb || !user) {
      if (!configured) {
        showNotConfigured();
      }

      return;
    }

    els.fixtures.innerHTML = `
      <div class="empty-card">
        Loading Matchweek ${currentMw}…
      </div>
    `;

    const [fixtureResult, predictionResult, confirmationResult] =
      await Promise.all([
        sb
          .from("fixtures")
          .select("*")
          .eq("matchweek", currentMw)
          .order("kickoff"),

        sb
          .from("predictions")
          .select(
            "fixture_id,home_pred,away_pred"
          )
          .eq("user_id", user.id),

        sb
          .from("confirmations")
          .select("*")
          .eq("user_id", user.id)
          .eq("matchweek", currentMw)
          .maybeSingle()
      ]);

    if (fixtureResult.error) {
      els.fixtures.innerHTML = `
        <div class="empty-card">
          ${escapeHtml(fixtureResult.error.message)}
        </div>
      `;

      return;
    }

    fixtures = fixtureResult.data || [];

    predictions = new Map(
      (predictionResult.data || []).map((prediction) => [
        String(prediction.fixture_id),
        prediction
      ])
    );

    confirmation =
      confirmationResult.data || null;

    renderFixtures(fixtures);
    updateConfirmBar();
  }

  // ----------------------------------------------------------
  // DISPLAY FIXTURES
  // ----------------------------------------------------------

  function renderFixtures(list) {
    if (!user && configured) {
      els.fixtures.innerHTML = `
        <div class="empty-card">
          Sign in to make your predictions.
        </div>
      `;

      return;
    }

    if (!list.length) {
      els.fixtures.innerHTML = `
        <div class="empty-card">
          No fixtures loaded for Matchweek ${currentMw}.
        </div>
      `;

      updateConfirmBar();
      return;
    }

    els.fixtures.innerHTML = list
      .map((fixture) => {
        const prediction =
          predictions.get(String(fixture.id)) || {};

        const locked = !!confirmation;

        // --------------------------------------------------
        // THIS IS THE IMPORTANT FINAL-SCORE CHECK
        // --------------------------------------------------

        const finished =
          fixture.status === "FINISHED" &&
          fixture.home_score !== null &&
          fixture.home_score !== undefined &&
          fixture.away_score !== null &&
          fixture.away_score !== undefined;

        const dateObject =
          new Date(fixture.kickoff);

        const date = isNaN(dateObject)
          ? fixture.kickoff
          : dateObject.toLocaleString([], {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit"
            });

        const predictionExists =
          prediction.home_pred !== null &&
          prediction.home_pred !== undefined &&
          prediction.away_pred !== null &&
          prediction.away_pred !== undefined;

        const points =
          finished && predictionExists
            ? scorePoints(prediction, fixture)
            : null;

        // Final result displayed between teams
        const centreScore = finished
          ? `
            <div style="
              text-align:center;
              font-size:24px;
              font-weight:800;
              color:#b8ff43;
              line-height:1;
            ">
              ${fixture.home_score}–${fixture.away_score}
              <div style="
                font-size:9px;
                letter-spacing:.12em;
                margin-top:6px;
                color:#8f9ab5;
              ">
                FT
              </div>
            </div>
          `
          : `<div class="versus">VS</div>`;

        return `
          <article class="fixture-card">

            <div class="fixture-meta">
              <span>${escapeHtml(date)}</span>
              <span>${escapeHtml(
                fixture.status || "SCHEDULED"
              )}</span>
            </div>

            <div class="teams">

              <div class="team">
                ${escapeHtml(fixture.home_team)}
                <div style="
                  font-size:9px;
                  color:#8f9ab5;
                  margin-top:4px;
                  letter-spacing:.1em;
                ">
                  HOME
                </div>
              </div>

              ${centreScore}

              <div class="team away">
                ${escapeHtml(fixture.away_team)}
                <div style="
                  font-size:9px;
                  color:#8f9ab5;
                  margin-top:4px;
                  letter-spacing:.1em;
                ">
                  AWAY
                </div>
              </div>

            </div>

            <div class="prediction-inputs">

              <input
                inputmode="numeric"
                min="0"
                max="20"
                type="number"
                data-fixture="${fixture.id}"
                data-side="home"
                value="${prediction.home_pred ?? ""}"
                ${locked ? "disabled" : ""}
              >

              <div class="dash">—</div>

              <input
                inputmode="numeric"
                min="0"
                max="20"
                type="number"
                data-fixture="${fixture.id}"
                data-side="away"
                value="${prediction.away_pred ?? ""}"
                ${locked ? "disabled" : ""}
              >

            </div>

            ${
              predictionExists
                ? `
                  <div class="actual">
                    Your prediction:
                    <strong>
                      ${prediction.home_pred}–${prediction.away_pred}
                    </strong>
                  </div>
                `
                : ""
            }

            ${
              finished
                ? `
                  <div class="actual">
                    Final score:
                    <strong>
                      ${fixture.home_team}
                      ${fixture.home_score}–${fixture.away_score}
                      ${fixture.away_team}
                    </strong>

                    ${
                      points !== null
                        ? `
                          ·
                          <strong>
                            +${points} pts
                          </strong>
                        `
                        : ""
                    }
                  </div>
                `
                : ""
            }

          </article>
        `;
      })
      .join("");

    els.fixtures
      .querySelectorAll("input")
      .forEach((input) => {
        input.addEventListener(
          "change",
          savePrediction
        );
      });
  }

  // ----------------------------------------------------------
  // SAVE PREDICTION
  // ----------------------------------------------------------

  async function savePrediction(event) {
    if (!sb || !user || confirmation) {
      return;
    }

    const fixtureId =
      String(event.target.dataset.fixture);

    const card =
      event.target.closest(".fixture-card");

    const inputs =
      [...card.querySelectorAll("input")];

    const home =
      inputs[0].value;

    const away =
      inputs[1].value;

    if (home === "" || away === "") {
      return;
    }

    const payload = {
      user_id: user.id,
      fixture_id: Number(fixtureId),
      home_pred: Number(home),
      away_pred: Number(away),
      updated_at:
        new Date().toISOString()
    };

    const { error } = await sb
      .from("predictions")
      .upsert(payload, {
        onConflict: "user_id,fixture_id"
      });

    if (error) {
      toast(error.message);
      return;
    }

    predictions.set(
      fixtureId,
      payload
    );

    toast("Prediction saved ✓");

    updateConfirmBar();
  }

  // ----------------------------------------------------------
  // CONFIRM / LOCK
  // ----------------------------------------------------------

  function updateConfirmBar() {
    const complete =
      fixtures.length > 0 &&
      fixtures.every((fixture) => {
        const prediction =
          predictions.get(
            String(fixture.id)
          );

        return (
          prediction &&
          prediction.home_pred !== null &&
          prediction.home_pred !== undefined &&
          prediction.away_pred !== null &&
          prediction.away_pred !== undefined
        );
      });

    if (confirmation) {
      els.confirm.disabled = true;
      els.confirm.textContent = "Locked ✓";

      els.confirmTitle.textContent =
        `Matchweek ${currentMw} confirmed`;

      els.confirmText.textContent =
        `Locked ${new Date(
          confirmation.confirmed_at
        ).toLocaleString()}. Your scorelines cannot be changed.`;

      els.banner.textContent =
        "✓ Predictions confirmed and locked.";

      els.banner.classList.remove("hidden");
    } else {
      els.confirm.disabled = !complete;
      els.confirm.textContent =
        "Confirm predictions";

      els.confirmTitle.textContent =
        complete
          ? "Ready to lock"
          : "Predictions open";

      els.confirmText.textContent =
        complete
          ? "Confirming will permanently lock this matchweek."
          : "Complete every match, then confirm to lock this matchweek.";

      els.banner.classList.add("hidden");
    }
  }

  async function confirmWeek() {
    const accepted = confirm(
      `Lock all Matchweek ${currentMw} predictions? You will not be able to edit them afterward.`
    );

    if (!accepted) return;

    els.confirm.disabled = true;

    const { error } = await sb.rpc(
      "confirm_matchweek",
      {
        p_matchweek: currentMw
      }
    );

    if (error) {
      toast(error.message);
      updateConfirmBar();
      return;
    }

    toast(
      `Matchweek ${currentMw} locked ✓`
    );

    await loadWeek();
  }

  // ----------------------------------------------------------
  // SCORING
  // ----------------------------------------------------------

  function scorePoints(
    prediction,
    fixture
  ) {
    if (
      prediction.home_pred == null ||
      prediction.away_pred == null ||
      fixture.home_score == null ||
      fixture.away_score == null
    ) {
      return null;
    }

    const predictedHome =
      Number(prediction.home_pred);

    const predictedAway =
      Number(prediction.away_pred);

    const actualHome =
      Number(fixture.home_score);

    const actualAway =
      Number(fixture.away_score);

    // Exact score = 4
    if (
      predictedHome === actualHome &&
      predictedAway === actualAway
    ) {
      return 4;
    }

    // Correct win / draw / loss = 3
    const predictedOutcome =
      Math.sign(
        predictedHome -
        predictedAway
      );

    const actualOutcome =
      Math.sign(
        actualHome -
        actualAway
      );

    if (
      predictedOutcome === actualOutcome
    ) {
      return 3;
    }

    // Wrong result = 0
    return 0;
  }

  // ----------------------------------------------------------
  // LEADERBOARD
  // ----------------------------------------------------------

  async function loadLeaderboard() {
    if (!sb) {
      els.leaderboard.innerHTML = `
        <div class="empty-card borderless">
          Configure Supabase first.
        </div>
      `;

      return;
    }

    els.leaderboard.innerHTML = `
      <div class="empty-card borderless">
        Loading leaderboard…
      </div>
    `;

    const { data, error } =
      await sb.rpc(
        "get_leaderboard"
      );

    if (error) {
      els.leaderboard.innerHTML = `
        <div class="empty-card borderless">
          ${escapeHtml(error.message)}
        </div>
      `;

      return;
    }

    if (!data?.length) {
      els.leaderboard.innerHTML = `
        <div class="empty-card borderless">
          No finished matches yet.
        </div>
      `;

      return;
    }

    els.leaderboard.innerHTML =
      data
        .map(
          (row, index) => `
            <div class="leader-row ${
              index < 3 ? "top" : ""
            }">

              <span class="rank">
                ${row.rank}
              </span>

              <span class="player-cell">
                ${escapeHtml(
                  row.display_name
                )}

                <small>
                  ${row.matches_scored}
                  scored ${
                    row.matches_scored === 1
                      ? "match"
                      : "matches"
                  }
                </small>
              </span>

              <span class="points">
                ${row.total_points}
              </span>

              <span>
                ${row.exact_scores}
              </span>

              <span>
                ${row.correct_outcomes}
              </span>

            </div>
          `
        )
        .join("");
  }

  // ----------------------------------------------------------
  // START
  // ----------------------------------------------------------

  if (sb) {
    sb.auth.onAuthStateChange(() => {
      setTimeout(
        refreshAuth,
        0
      );
    });
  }

  refreshAuth();
})();

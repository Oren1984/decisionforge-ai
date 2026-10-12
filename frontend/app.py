"""DecisionForge AI dashboard.

A thin Streamlit client for the backend API. All decision logic, validation and
policy enforcement live in the backend; this app only collects input and renders
what the API returns.
"""

from __future__ import annotations

import os
import uuid
from typing import Any

import altair as alt
import pandas as pd
import requests
import streamlit as st

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:3000").rstrip("/")

MODES = {
    "Deterministic Rules": "rules",
    "Contract Mock": "mock",
    "Local Ollama": "ollama",
}
MODE_LABELS = {value: label for label, value in MODES.items()}
PROVIDER_LABELS = {"DETERMINISTIC_RULES": "Rules", "CONTRACT_MOCK": "Mock", "LOCAL_OLLAMA": "Ollama", "FAILSAFE": "Fail-safe"}
MODE_HELP = {
    "rules": "Pure rule evaluation over the structured fields. No model involved.",
    "mock": "A deterministic simulation of a naive model. It is not AI inference.",
    "ollama": "Real inference by a local model through Ollama, when the runtime is available.",
}

# Status colors with a fixed icon and label, so a decision is never shown by color alone.
DECISIONS = {
    "APPROVED": {"label": "Approved", "icon": "✅", "color": "#0ca30c"},
    "HUMAN_REVIEW": {"label": "Human review", "icon": "🧑‍⚖️", "color": "#fab219"},
    "REJECTED": {"label": "Rejected", "icon": "⛔", "color": "#d03b3b"},
}

CATEGORIES = ["DEPLOYMENT", "ACCESS_GRANT", "INFRASTRUCTURE_CHANGE", "VENDOR_PAYMENT"]
URGENCIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"]
RISK_LEVELS = ["LOW", "MEDIUM", "HIGH"]
CUSTOM_INPUT = "Custom input"

# Evaluating a local model over the full dataset can take minutes.
EVALUATE_TIMEOUT_S = 900


class BackendError(Exception):
    """The backend could not be reached or answered with an error."""


def api(method: str, path: str, *, timeout: float = 30, **kwargs: Any) -> Any:
    try:
        response = requests.request(method, f"{BACKEND_URL}{path}", timeout=timeout, **kwargs)
    except requests.RequestException as error:
        raise BackendError(f"Backend at {BACKEND_URL} is not reachable ({error.__class__.__name__}).") from error

    if response.status_code == 400:
        body = response.json()
        issues = body.get("issues") or [{"path": "", "message": body.get("message", "Bad request")}]
        details = "; ".join(f"{issue['path'] or 'body'}: {issue['message']}" for issue in issues)
        raise BackendError(f"The backend rejected the input. {details}")
    if not response.ok:
        raise BackendError(f"Backend responded with HTTP {response.status_code}.")
    return response.json()


# With Ollama absent, the backend's probe waits out its timeout; avoid paying that on every rerun.
@st.cache_data(ttl=15, show_spinner=False)
def load_health() -> dict[str, Any]:
    return api("GET", "/api/health", timeout=10)


@st.cache_data(ttl=300, show_spinner=False)
def load_scenarios() -> list[dict[str, Any]]:
    return api("GET", "/api/scenarios")


@st.cache_data(ttl=300, show_spinner=False)
def load_contract() -> dict[str, Any]:
    return api("GET", "/api/contract")


def decision_badge(decision: str) -> str:
    meta = DECISIONS[decision]
    return f"{meta['icon']} {meta['label']}"


def yes_no(value: bool) -> str:
    return "Yes" if value else "No"


# --------------------------------------------------------------------------- sidebar


def render_sidebar() -> str:
    st.sidebar.title("DecisionForge AI")
    st.sidebar.caption("Typed decision contracts and deterministic policy gates around local AI inference.")
    view = st.sidebar.radio(
        "View",
        ["Decision Sandbox", "Policy & Contract Inspector", "Benchmark & Evaluation"],
    )

    st.sidebar.divider()
    st.sidebar.subheader("System status")
    try:
        health = load_health()
    except BackendError as error:
        st.sidebar.error(str(error))
        return view

    st.sidebar.success("Backend: online")
    ollama = health["ollama"]
    if ollama["reachable"] and ollama["modelAvailable"]:
        st.sidebar.success(f"Ollama: ready ({ollama['model']})")
    elif ollama["reachable"]:
        st.sidebar.warning(f"Ollama: running, model {ollama['model']} not pulled")
    else:
        st.sidebar.info("Ollama: not running. Rules and mock modes work without it.")
    return view


# --------------------------------------------------------------------------- sandbox


def render_request_form(scenario: dict[str, Any] | None) -> tuple[dict[str, Any], str] | None:
    """Renders the request form. Returns (request payload, provider mode) on submit."""
    payload = scenario["inputPayload"] if scenario else {}
    # Widget keys include the scenario id so picking another scenario resets the fields.
    key = scenario["id"] if scenario else "custom"

    with st.form(f"request-{key}"):
        left, right = st.columns(2)
        category = left.selectbox(
            "Category", CATEGORIES, index=CATEGORIES.index(payload.get("category", "DEPLOYMENT")), key=f"category-{key}"
        )
        urgency = right.selectbox(
            "Urgency", URGENCIES, index=URGENCIES.index(payload.get("urgency", "LOW")), key=f"urgency-{key}"
        )
        risk_level = left.selectbox(
            "Risk level", RISK_LEVELS, index=RISK_LEVELS.index(payload.get("riskLevel", "LOW")), key=f"risk-{key}"
        )
        budget = right.number_input(
            "Budget impact (USD)",
            min_value=0.0,
            value=float(payload.get("budgetImpactUsd", 500.0)),
            step=100.0,
            format="%.2f",
            key=f"budget-{key}",
        )
        security = st.checkbox(
            "Security validation completed",
            value=payload.get("securityValidationCompleted", True),
            key=f"security-{key}",
        )
        justification = st.text_area(
            "Justification (untrusted free text, max 500 characters)",
            value=payload.get("justification", ""),
            height=110,
            key=f"justification-{key}",
            help="This text is treated as data. It cannot change the structured fields or bypass a constraint.",
        )
        mode_label = st.radio(
            "Engine mode",
            list(MODES),
            horizontal=True,
            key=f"mode-{key}",
            captions=[MODE_HELP[mode] for mode in MODES.values()],
        )
        submitted = st.form_submit_button("Run decision", type="primary")

    if not submitted:
        return None
    request = {
        "requestId": payload.get("requestId") or str(uuid.uuid4()),
        "category": category,
        "justification": justification,
        "urgency": urgency,
        "riskLevel": risk_level,
        "securityValidationCompleted": security,
        "budgetImpactUsd": budget,
    }
    return request, MODES[mode_label]


def render_decision_card(outcome: dict[str, Any]) -> None:
    result, audit = outcome["result"], outcome["audit"]
    meta = DECISIONS[result["decision"]]

    with st.container(border=True):
        st.markdown(
            f"<div style='border-left: 6px solid {meta['color']}; padding-left: 12px'>"
            f"<div style='font-size: 0.85rem; opacity: 0.7'>Decision</div>"
            f"<div style='font-size: 1.8rem; font-weight: 600'>{meta['icon']} {meta['label']}</div></div>",
            unsafe_allow_html=True,
        )
        first, second, third, fourth = st.columns(4)
        first.metric("Confidence", f"{result['confidenceScore']:.2f}")
        second.metric("Provider", PROVIDER_LABELS[result["providerUsed"]])
        third.metric("Execution time", f"{result['executionTimeMs']:.1f} ms")
        fourth.metric("Human oversight", "Required" if result["requiresHumanOversight"] else "Not required")

        if audit["failsafe"]:
            st.warning("The provider failed, so the engine abstained to human review. No decision was inferred.")
        elif audit["policyOverridden"]:
            st.warning(
                f"Policy override: the provider recommended {decision_badge(audit['providerDecision'])}, "
                "and the policy engine replaced it."
            )
        if audit["providerMode"] == "mock":
            st.caption("Contract Mock is a deterministic simulation, not AI inference.")

        st.markdown("**Rationale**")
        st.write(result["rationale"])
        st.markdown("**Applied policy rules**")
        if result["appliedPolicyRules"]:
            st.markdown("\n".join(f"- `{rule}`" for rule in result["appliedPolicyRules"]))
        else:
            st.write("None")

    expected = outcome.get("expected")
    if expected:
        if expected["decision"] == result["decision"]:
            st.success(f"Matches the dataset label: {decision_badge(expected['decision'])}")
        else:
            st.error(
                f"Differs from the dataset label: expected {decision_badge(expected['decision'])}, "
                f"got {decision_badge(result['decision'])}"
            )


def render_sandbox() -> None:
    st.title("Interactive Decision Sandbox")
    st.write("Submit a business request and see the policy-enforced decision.")

    scenarios = {scenario["id"]: scenario for scenario in load_scenarios()}

    def scenario_label(option: str) -> str:
        if option == CUSTOM_INPUT:
            return option
        scenario = scenarios[option]
        text = scenario["inputPayload"]["justification"].strip() or "(empty justification)"
        return f"{option} · {text[:70]}"

    choice = st.selectbox("Scenario", [CUSTOM_INPUT, *scenarios], format_func=scenario_label)
    scenario = scenarios.get(choice)
    if scenario:
        st.caption(
            f"Pre-built scenario. Dataset label: {decision_badge(scenario['expectedDecision'])}. "
            "You can edit any field before running."
        )

    submission = render_request_form(scenario)
    if submission:
        request, mode = submission
        try:
            with st.spinner("Running decision..."):
                outcome = api("POST", "/api/decision", json={"providerMode": mode, "request": request}, timeout=120)
        except BackendError as error:
            st.session_state.pop("last_outcome", None)
            st.error(str(error))
            return
        # The label only applies while the scenario's payload is unedited.
        if scenario and request == scenario["inputPayload"]:
            outcome["expected"] = {"decision": scenario["expectedDecision"]}
        outcome["request"] = request
        st.session_state["last_outcome"] = outcome

    if "last_outcome" in st.session_state:
        render_decision_card(st.session_state["last_outcome"])


# --------------------------------------------------------------------------- inspector


def describe_field(spec: dict[str, Any]) -> str:
    if "enum" in spec:
        return "one of " + ", ".join(spec["enum"])
    parts = []
    if "format" in spec:
        parts.append(spec["format"])
    if "maxLength" in spec:
        parts.append(f"max {spec['maxLength']} characters")
    if "minLength" in spec:
        parts.append(f"min {spec['minLength']} characters")
    if "exclusiveMinimum" in spec:
        parts.append(f"greater than {spec['exclusiveMinimum']}")
    if "minimum" in spec:
        parts.append(f"at least {spec['minimum']}")
    if "maximum" in spec:
        parts.append(f"at most {spec['maximum']}")
    if spec.get("type") == "array":
        parts.append(f"items: {spec.get('items', {}).get('type', 'any')}")
    return ", ".join(parts) or "—"


def schema_table(schema: dict[str, Any]) -> pd.DataFrame:
    required = set(schema.get("required", []))
    return pd.DataFrame(
        [
            {
                "Field": name,
                "Type": spec.get("type", "—"),
                "Constraint": describe_field(spec),
                "Required": yes_no(name in required),
            }
            for name, spec in schema["properties"].items()
        ]
    )


def render_audit_trace(entry: dict[str, Any]) -> None:
    attempts = entry["attempts"] or [{"provider": "none", "outcome": "not attempted", "reason": None}]
    steps = ["**1. Input validation** — passed"]
    for attempt in attempts:
        reason = f" ({attempt['reason']})" if attempt["reason"] else ""
        steps.append(f"**2. Provider execution** — `{attempt['provider']}`: {attempt['outcome']}{reason}")
    proposed = decision_badge(entry["providerDecision"]) if entry["providerDecision"] else "none (fail-safe used)"
    steps.append(f"**3. Provider recommendation** — {proposed}")
    violated = ", ".join(f"`{rule}`" for rule in entry["violatedConstraints"]) or "none"
    steps.append(
        f"**4. Policy enforcement** — violated constraints: {violated}; "
        f"recommendation overridden: {yes_no(entry['policyOverridden'])}"
    )
    steps.append(
        f"**5. Final decision** — {decision_badge(entry['finalDecision'])}; "
        f"human oversight required: {yes_no(entry['requiresHumanOversight'])}"
    )
    st.markdown("\n\n".join(steps))
    with st.expander("Raw audit entry"):
        st.json(entry)


def render_inspector() -> None:
    st.title("Policy & Contract Inspector")
    contract = load_contract()

    st.header("Input contract")
    st.write("Every request is validated against this schema before any provider runs. Unknown fields are rejected.")
    st.dataframe(schema_table(contract["requestSchema"]), hide_index=True, width="stretch")

    with st.expander("Decision result contract"):
        st.dataframe(schema_table(contract["resultSchema"]), hide_index=True, width="stretch")

    st.header("Hard constraints")
    st.write(
        "These are applied after the provider answers. They can turn an approval into a human review; "
        "they never relax a decision, and no provider output or justification text can switch them off."
    )
    st.dataframe(
        pd.DataFrame(contract["hardConstraints"]).rename(columns={"id": "Constraint", "description": "Rule"}),
        hide_index=True,
        width="stretch",
    )

    st.header("Audit trace")
    entries = api("GET", "/api/audit", params={"limit": 50})["entries"]
    if not entries:
        st.info("No decisions recorded yet. Run one in the Decision Sandbox.")
        return

    entries = list(reversed(entries))
    st.caption("Most recent decisions first. The audit log is held in memory and resets when the backend restarts.")
    st.dataframe(
        pd.DataFrame(
            [
                {
                    "Time (UTC)": entry["timestamp"].replace("T", " ")[:19],
                    "Mode": MODE_LABELS[entry["providerMode"]],
                    "Provider proposed": decision_badge(entry["providerDecision"]) if entry["providerDecision"] else "—",
                    "Final decision": decision_badge(entry["finalDecision"]),
                    "Overridden": yes_no(entry["policyOverridden"]),
                    "Fail-safe": yes_no(entry["failsafe"]),
                    "Request": entry["requestId"],
                }
                for entry in entries
            ]
        ),
        hide_index=True,
        width="stretch",
    )

    selected = st.selectbox(
        "Inspect a decision",
        range(len(entries)),
        format_func=lambda index: (
            f"{entries[index]['timestamp'][11:19]} · {MODE_LABELS[entries[index]['providerMode']]} · "
            f"{DECISIONS[entries[index]['finalDecision']]['label']}"
        ),
    )
    render_audit_trace(entries[selected])


# --------------------------------------------------------------------------- benchmark


def distribution_chart(results: list[dict[str, Any]]) -> alt.LayerChart:
    order = list(DECISIONS)
    rows = [
        {
            "Mode": MODE_LABELS[metrics["mode"]],
            "Decision": DECISIONS[decision]["label"],
            "Scenarios": metrics["decisionDistribution"][decision],
            "order": order.index(decision),
        }
        for metrics in results
        for decision in order
    ]
    labels = [DECISIONS[decision]["label"] for decision in order]
    base = alt.Chart(pd.DataFrame(rows)).encode(
        y=alt.Y("Mode:N", title=None, scale=alt.Scale(paddingInner=0.3, paddingOuter=0.2), sort=[MODE_LABELS[metrics["mode"]] for metrics in results]),
        x=alt.X("Scenarios:Q", stack="zero", title="Scenarios"),
        order=alt.Order("order:Q"),
    )
    bars = base.mark_bar().encode(
        color=alt.Color(
            "Decision:N",
            scale=alt.Scale(domain=labels, range=[DECISIONS[decision]["color"] for decision in order]),
            legend=alt.Legend(orient="top", title=None),
        ),
        tooltip=["Mode:N", "Decision:N", "Scenarios:Q"],
    )
    # Counts are written on the segments so the split does not depend on color.
    counts = base.transform_filter(alt.datum.Scenarios >= 4).mark_text(dx=-14, color="#1a1a19", fontWeight="bold").encode(
        text="Scenarios:Q"
    )
    return (bars + counts).properties(height=alt.Step(48))


def render_benchmark() -> None:
    st.title("Benchmark & Research Evaluation")
    st.write(
        "Runs the 100 synthetic scenarios through each engine mode plus the policy gate, "
        "and scores the final decisions against the dataset labels."
    )

    with st.form("evaluate"):
        labels = st.multiselect("Engine modes", list(MODES), default=["Deterministic Rules", "Contract Mock"])
        submitted = st.form_submit_button("Run evaluation", type="primary")
    if submitted:
        if not labels:
            st.error("Select at least one engine mode.")
        else:
            try:
                with st.spinner("Evaluating scenarios. A local model can take several minutes."):
                    st.session_state["evaluation"] = api(
                        "POST",
                        "/api/evaluate",
                        json={"modes": [MODES[label] for label in labels]},
                        timeout=EVALUATE_TIMEOUT_S,
                    )
            except BackendError as error:
                st.error(str(error))

    evaluation = st.session_state.get("evaluation")
    if not evaluation:
        st.info("Select engine modes and run the evaluation to see results.")
        return

    for skipped in evaluation["skipped"]:
        st.warning(f"{MODE_LABELS[skipped['mode']]} was skipped: {skipped['reason']}")
    results = evaluation["results"]
    if not results:
        return

    st.caption(
        f"{evaluation['datasetSize']} scenarios. Contract Mock is a deterministic simulation of a naive model; "
        "only Local Ollama is real model inference."
    )

    st.header("Summary")
    st.dataframe(
        pd.DataFrame(
            [
                {
                    "Mode": MODE_LABELS[metrics["mode"]],
                    "Accuracy (%)": metrics["decisionAccuracyPct"],
                    "Policy violations (%)": metrics["policyViolationRatePct"],
                    "Human review (%)": metrics["humanReviewRatePct"],
                    "Fallback (%)": metrics["fallbackRatePct"],
                    "Schema errors (%)": metrics["schemaValidationErrorRatePct"],
                    "Avg latency (ms)": metrics["averageLatencyMs"],
                }
                for metrics in results
            ]
        ),
        hide_index=True,
        width="stretch",
    )

    st.header("Decision distribution")
    st.altair_chart(distribution_chart(results), width="stretch")

    st.header("Safety override effectiveness")
    st.write(
        "How often the policy engine had to replace a provider's recommendation, and how many unsafe approvals "
        "still got through. The second number must be zero."
    )
    for metrics in results:
        overrides = round(metrics["policyOverrideRatePct"] * metrics["totalScenarios"] / 100)
        violations = round(metrics["policyViolationRatePct"] * metrics["totalScenarios"] / 100)
        name, overridden, escaped = st.columns([2, 2, 2])
        name.markdown(f"**{MODE_LABELS[metrics['mode']]}**")
        overridden.metric("Recommendations overridden", overrides)
        escaped.metric("Unsafe approvals after enforcement", violations)

    st.header("Mismatches against dataset labels")
    mismatches = [
        {
            "Mode": MODE_LABELS[metrics["mode"]],
            "Scenario": mismatch["id"],
            "Expected": decision_badge(mismatch["expected"]),
            "Actual": decision_badge(mismatch["actual"]) if mismatch["actual"] else "invalid input",
        }
        for metrics in results
        for mismatch in metrics["mismatches"]
    ]
    if mismatches:
        st.dataframe(pd.DataFrame(mismatches), hide_index=True, width="stretch")
    else:
        st.write("None.")


# --------------------------------------------------------------------------- entry point


def main() -> None:
    st.set_page_config(page_title="DecisionForge AI", page_icon="⚖️", layout="wide")
    view = render_sidebar()
    try:
        if view == "Decision Sandbox":
            render_sandbox()
        elif view == "Policy & Contract Inspector":
            render_inspector()
        else:
            render_benchmark()
    except BackendError as error:
        st.error(str(error))


main()

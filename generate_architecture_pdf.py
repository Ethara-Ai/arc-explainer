

import os
import math
from reportlab.lib.pagesizes import letter
from reportlab.lib.colors import Color, HexColor
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# ── Dimensions (landscape letter) ──
PAGE_W, PAGE_H = letter[1], letter[0]  # 792 x 612
MARGIN = 40
HEADER_H = 50
FOOTER_H = 30
CONTENT_TOP = PAGE_H - MARGIN - HEADER_H
CONTENT_BOT = MARGIN + FOOTER_H

# ── Colors ──
BG         = HexColor("#0B1120")
BG_SURFACE = HexColor("#111B2E")
BG_CARD    = HexColor("#162038")
BLUE       = HexColor("#3B82F6")
TEAL       = HexColor("#14B8A6")
AMBER      = HexColor("#F59E0B")
PURPLE     = HexColor("#A78BFA")
RED        = HexColor("#EF4444")
GREEN      = HexColor("#22C55E")
WHITE      = HexColor("#E2E8F0")
DIM        = HexColor("#64748B")
FAINT      = HexColor("#334155")
ACCENT_LINE = HexColor("#1E3A5F")

LAYER_COLORS = {
    "entry":    BLUE,
    "orch":     BLUE,
    "runner":   TEAL,
    "adapter":  AMBER,
    "provider": PURPLE,
    "context":  TEAL,
    "api":      BLUE,
    "trace":    GREEN,
    "frontend": PURPLE,
}

# ── Fonts ──
FONT_DIR = os.path.join(os.path.dirname(__file__),
    ".claude", "skills", "canvas-design", "canvas-fonts")

FONT_FALLBACKS = {
    "WorkSans-Bold": "Helvetica-Bold",
    "WorkSans": "Helvetica",
    "InstrumentSans": "Helvetica",
    "InstrumentSans-Bold": "Helvetica-Bold",
    "JetBrainsMono": "Courier",
    "JetBrainsMono-Bold": "Courier-Bold",
    "Jura-Light": "Helvetica",
    "Jura": "Helvetica",
    "Italiana": "Helvetica",
}

def register_fonts():
    fonts = [
        ("WorkSans-Bold",        "WorkSans-Bold.ttf"),
        ("WorkSans",             "WorkSans-Regular.ttf"),
        ("InstrumentSans",       "InstrumentSans-Regular.ttf"),
        ("InstrumentSans-Bold",  "InstrumentSans-Bold.ttf"),
        ("JetBrainsMono",        "JetBrainsMono-Regular.ttf"),
        ("JetBrainsMono-Bold",   "JetBrainsMono-Bold.ttf"),
        ("Jura-Light",           "Jura-Light.ttf"),
        ("Jura",                 "Jura-Medium.ttf"),
        ("Italiana",             "Italiana-Regular.ttf"),
    ]
    registered = set()
    for name, filename in fonts:
        path = os.path.join(FONT_DIR, filename)
        if os.path.exists(path):
            try:
                pdfmetrics.registerFont(TTFont(name, path))
                registered.add(name)
            except Exception as e:
                print(f"Warning: Could not load {filename}: {e}")
    for name, fallback in FONT_FALLBACKS.items():
        if name not in registered:
            FONT_FALLBACKS[name] = fallback
            print(f"Using fallback {fallback} for {name}")

def font(name):
    """Resolve font name to registered font or fallback."""
    try:
        pdfmetrics.getFont(name)
        return name
    except KeyError:
        return FONT_FALLBACKS.get(name, "Helvetica")

# ── Drawing Helpers ──

def fill_bg(c):
    c.setFillColor(BG)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)

def draw_grid_dots(c, spacing=30, radius=0.5):
    c.setFillColor(Color(0.2, 0.3, 0.5, 0.15))
    for x in range(int(MARGIN), int(PAGE_W - MARGIN), spacing):
        for y in range(int(MARGIN + FOOTER_H), int(PAGE_H - MARGIN - HEADER_H), spacing):
            c.circle(x, y, radius, fill=1, stroke=0)

def draw_header(c, title, page_num, total=8):
    # Header bar
    c.setFillColor(BG_SURFACE)
    c.rect(0, PAGE_H - HEADER_H - MARGIN + 10, PAGE_W, HEADER_H + MARGIN - 10, fill=1, stroke=0)
    # Title
    c.setFillColor(WHITE)
    c.setFont(font("WorkSans-Bold"), 13)
    c.drawString(MARGIN, PAGE_H - MARGIN - 8, title)
    # Page indicator
    c.setFont(font("Jura"), 9)
    c.setFillColor(DIM)
    c.drawRightString(PAGE_W - MARGIN, PAGE_H - MARGIN - 8, f"{page_num} / {total}")
    # Thin accent line
    c.setStrokeColor(BLUE)
    c.setLineWidth(2)
    c.line(MARGIN, PAGE_H - MARGIN - HEADER_H + 15, PAGE_W - MARGIN, PAGE_H - MARGIN - HEADER_H + 15)

def draw_footer(c, text="Eval Harness Architecture"):
    y = MARGIN + 10
    c.setStrokeColor(FAINT)
    c.setLineWidth(0.5)
    c.line(MARGIN, y + 10, PAGE_W - MARGIN, y + 10)
    c.setFillColor(DIM)
    c.setFont(font("Jura-Light"), 7)
    c.drawCentredString(PAGE_W / 2, y, text)

def rounded_rect(c, x, y, w, h, r=6, fill_color=None, stroke_color=None, stroke_width=1):
    """Draw a rounded rectangle. (x,y) is bottom-left."""
    c.saveState()
    if fill_color:
        c.setFillColor(fill_color)
    if stroke_color:
        c.setStrokeColor(stroke_color)
        c.setLineWidth(stroke_width)
    p = c.beginPath()
    p.moveTo(x + r, y)
    p.lineTo(x + w - r, y)
    p.arcTo(x + w - r, y, x + w, y + r, 0, 90)
    p.lineTo(x + w, y + h - r)
    p.arcTo(x + w - r, y + h - r, x + w, y + h, 0, 90)
    p.lineTo(x + r, y + h)
    p.arcTo(x, y + h - r, x + r, y + h, 0, 90)
    p.lineTo(x, y + r)
    p.arcTo(x, y, x + r, y + r, 0, 90)
    p.close()
    if fill_color and stroke_color:
        c.drawPath(p, fill=1, stroke=1)
    elif fill_color:
        c.drawPath(p, fill=1, stroke=0)
    else:
        c.drawPath(p, fill=0, stroke=1)
    c.restoreState()

def draw_box(c, x, y, w, h, label, accent=BLUE, sublabel=None):
    """Draw a styled card box with left accent stripe. (x,y) = bottom-left."""
    # Shadow
    rounded_rect(c, x + 2, y - 2, w, h, r=5, fill_color=Color(0, 0, 0, 0.3))
    # Main bg
    dark_bg = Color(
        accent.red * 0.15 + BG.red * 0.85,
        accent.green * 0.15 + BG.green * 0.85,
        accent.blue * 0.15 + BG.blue * 0.85,
    )
    rounded_rect(c, x, y, w, h, r=5, fill_color=dark_bg, stroke_color=Color(accent.red, accent.green, accent.blue, 0.4), stroke_width=0.8)
    # Left accent stripe
    c.setFillColor(accent)
    c.rect(x, y + 4, 3, h - 8, fill=1, stroke=0)
    # Label
    c.setFillColor(WHITE)
    c.setFont(font("InstrumentSans-Bold"), 10)
    c.drawString(x + 12, y + h - 16, label)
    if sublabel:
        c.setFillColor(DIM)
        c.setFont(font("JetBrainsMono"), 7)
        c.drawString(x + 12, y + h - 28, sublabel)

def draw_arrow_down(c, x, y_top, y_bot, color=FAINT, label=None):
    """Vertical arrow pointing down."""
    c.setStrokeColor(color)
    c.setLineWidth(1)
    c.setDash([3, 3])
    c.line(x, y_top, x, y_bot + 6)
    c.setDash([])
    # Arrowhead
    c.setFillColor(color)
    p = c.beginPath()
    p.moveTo(x, y_bot)
    p.lineTo(x - 4, y_bot + 8)
    p.lineTo(x + 4, y_bot + 8)
    p.close()
    c.drawPath(p, fill=1, stroke=0)
    if label:
        c.setFillColor(DIM)
        c.setFont(font("JetBrainsMono"), 6)
        c.drawString(x + 6, (y_top + y_bot) / 2, label)

def draw_arrow_right(c, x_left, x_right, y, color=FAINT, label=None):
    """Horizontal arrow pointing right."""
    c.setStrokeColor(color)
    c.setLineWidth(1)
    c.setDash([3, 3])
    c.line(x_left, y, x_right - 6, y)
    c.setDash([])
    c.setFillColor(color)
    p = c.beginPath()
    p.moveTo(x_right, y)
    p.lineTo(x_right - 8, y - 4)
    p.lineTo(x_right - 8, y + 4)
    p.close()
    c.drawPath(p, fill=1, stroke=0)
    if label:
        c.setFillColor(DIM)
        c.setFont(font("JetBrainsMono"), 6)
        c.drawCentredString((x_left + x_right) / 2, y + 6, label)

def code_block(c, x, y, w, lines, title=None):
    """Draw a code block. (x,y) = top-left, grows downward."""
    line_h = 11
    pad = 8
    title_h = 18 if title else 0
    h = title_h + pad * 2 + len(lines) * line_h
    bot = y - h
    # Background
    rounded_rect(c, x, bot, w, h, r=4, fill_color=Color(0.04, 0.06, 0.12, 1))
    # Border
    rounded_rect(c, x, bot, w, h, r=4, stroke_color=FAINT, stroke_width=0.5)
    cy = y
    if title:
        cy -= 4
        # Title bar
        c.setFillColor(DIM)
        c.setFont(font("Jura"), 7)
        c.drawString(x + pad, cy - 10, title)
        c.setStrokeColor(FAINT)
        c.setLineWidth(0.3)
        c.line(x + 4, cy - 14, x + w - 4, cy - 14)
        cy -= title_h
    cy -= pad
    for line in lines:
        cy -= line_h
        # Simple syntax coloring
        if line.strip().startswith("//") or line.strip().startswith("#"):
            c.setFillColor(DIM)
        elif any(kw in line for kw in ["async", "await", "const", "interface", "import", "from", "function", "return", "for", "if"]):
            c.setFillColor(PURPLE)
        elif "→" in line or "->" in line or "=>" in line:
            c.setFillColor(TEAL)
        elif '"' in line or "'" in line:
            c.setFillColor(GREEN)
        else:
            c.setFillColor(Color(0.7, 0.8, 0.95, 1))
        c.setFont(font("JetBrainsMono"), 7)
        c.drawString(x + pad, cy, line)
    return bot

def badge(c, x, y, text, color=BLUE):
    """Small colored tag."""
    tw = pdfmetrics.stringWidth(text, font("Jura"), 7) + 10
    rounded_rect(c, x, y - 4, tw, 14, r=3, fill_color=Color(color.red, color.green, color.blue, 0.2))
    c.setFillColor(color)
    c.setFont(font("Jura"), 7)
    c.drawString(x + 5, y, text)
    return x + tw + 4


# ═══════════════════════════════════════════════════════
# PAGE 1: TITLE
# ═══════════════════════════════════════════════════════

def page_title(c):
    fill_bg(c)
    draw_grid_dots(c, spacing=24, radius=0.4)

    # Decorative scan lines
    c.setStrokeColor(Color(0.15, 0.25, 0.5, 0.08))
    c.setLineWidth(0.3)
    for yy in range(50, int(PAGE_H), 8):
        c.line(0, yy, PAGE_W, yy)

    # Central composition
    cx, cy = PAGE_W / 2, PAGE_H / 2 + 40

    # Main title
    c.setFillColor(WHITE)
    c.setFont(font("WorkSans-Bold"), 48)
    c.drawCentredString(cx, cy + 30, "EVAL HARNESS")

    # Subtitle
    c.setFillColor(BLUE)
    c.setFont(font("Italiana"), 16)
    c.drawCentredString(cx, cy - 5, "Architecture & Execution Flow")

    # Thin separator
    c.setStrokeColor(BLUE)
    c.setLineWidth(1)
    c.line(cx - 120, cy - 20, cx + 120, cy - 20)

    # Description
    c.setFillColor(DIM)
    c.setFont(font("InstrumentSans"), 11)
    c.drawCentredString(cx, cy - 45, "How LLM agents play ARC puzzle games and get benchmarked")
    c.setFont(font("JetBrainsMono"), 8)
    c.drawCentredString(cx, cy - 65, "TypeScript  |  Python subprocess  |  10 LLM providers  |  Real-time SSE dashboard")

    # Mini architecture preview (abstract boxes)
    bx = cx - 180
    by = cy - 140
    layers = [
        ("CLI / HTTP", BLUE, 360, 28),
        ("Orchestrator", BLUE, 300, 28),
        ("Eval Runner", TEAL, 240, 28),
        ("Adapters  +  Providers  +  Context", AMBER, 360, 28),
    ]
    for i, (lbl, col, w, h) in enumerate(layers):
        lx = cx - w / 2
        ly = by - i * 42
        draw_box(c, lx, ly, w, h, lbl, accent=col)
        if i < len(layers) - 1:
            next_w = layers[i + 1][2]
            draw_arrow_down(c, cx, ly, ly - 14, color=col)

    # Bottom info
    c.setFillColor(FAINT)
    c.setFont(font("Jura-Light"), 8)
    c.drawCentredString(cx, 45, "arc-explainer  /  server/services/eval/")
    c.setFont(font("Jura-Light"), 7)
    c.drawCentredString(cx, 32, "March 2026")


# ═══════════════════════════════════════════════════════
# PAGE 2: HIGH-LEVEL ARCHITECTURE
# ═══════════════════════════════════════════════════════

def page_architecture(c):
    fill_bg(c)
    draw_grid_dots(c)
    draw_header(c, "High-Level Architecture", 2)
    draw_footer(c)

    # 4-layer vertical flow on the left half
    left_x = MARGIN + 10
    box_w = 320
    box_h = 55
    start_y = CONTENT_TOP - 30

    layers = [
        ("Layer 1: Entrypoint", "runner/index.ts  |  evalController.ts",
         BLUE, ["npm run eval  (CLI)", "POST /api/eval/start  (HTTP)", "Parses config: models, games, steps"]),
        ("Layer 2: Orchestrator", "evalOrchestrator.ts  (953 lines)",
         BLUE, ["3-level parallel: Games x Models x Runs", "p-limit concurrency control", "AbortController cancellation"]),
        ("Layer 3: Eval Runner", "evalRunner.ts  (1035 lines)",
         TEAL, ["THE HEART - step loop per game", "observe -> think -> act -> record", "Max steps + skip detection"]),
        ("Layer 4: Infrastructure", "adapters/ + providers/ + context/",
         AMBER, ["Game Adapter (Python subprocess)", "LLM Provider (10 implementations)", "Context Manager + Notepad + Traces"]),
    ]

    for i, (title, sub, color, details) in enumerate(layers):
        by = start_y - i * (box_h + 35)
        draw_box(c, left_x, by, box_w, box_h, title, accent=color, sublabel=sub)

        # Detail lines to the right
        dx = left_x + box_w + 15
        for j, detail in enumerate(details):
            dy = by + box_h - 16 - j * 12
            c.setFillColor(color)
            c.setFont(font("JetBrainsMono"), 6.5)
            c.drawString(dx, dy, detail)

        # Arrow to next
        if i < len(layers) - 1:
            draw_arrow_down(c, left_x + box_w / 2, by, by - 35 + box_h, color=color)

    # Execution chain code block on the right
    code_block(c, 450, CONTENT_TOP - 10, 300, [
        "// Execution chain",
        "runSession()",
        "  -> executeNested()",
        "    -> executeGame()     // spawn Python",
        "      -> executeModel()  // create provider",
        "        -> executeTaskSafe()  // error boundary",
        "          -> executeTask()    // build runner",
        "            -> EvalRunner.runGame()  // LOOP",
    ], title="Call Stack")

    # Parallelism diagram
    py = CONTENT_TOP - 200
    code_block(c, 450, py, 300, [
        "// Parallelism structure",
        "Session",
        " +-- Game ct01 ----+-- gpt-5.4 (run 1,2,3)",
        " |                 +-- gemini   (run 1,2,3)",
        " +-- Game ls20 ----+-- gpt-5.4 (run 1,2,3)",
        "                   +-- gemini   (run 1,2,3)",
        "",
        "Games:  parallel (p-limit)",
        "Models: parallel within game",
        "Runs:   sequential per model",
    ], title="Parallel Execution")


# ═══════════════════════════════════════════════════════
# PAGE 3: STEP LOOP (THE HEART)
# ═══════════════════════════════════════════════════════

def page_step_loop(c):
    fill_bg(c)
    draw_grid_dots(c)
    draw_header(c, "The Step Loop  —  evalRunner.ts", 3)
    draw_footer(c)

    # Central flow: 8 steps in 2 rows of 4
    step_w = 140
    step_h = 65
    gap_x = 18
    gap_y = 60

    row1_y = CONTENT_TOP - 30
    row1_x = MARGIN + 20

    steps_r1 = [
        ("1. Reset", TEAL, "adapter.reset()", "Initialize game state"),
        ("2. Observe", AMBER, "adapter.renderText()", "Get text grid + PNG"),
        ("3. Build Prompt", TEAL, "promptBuilder.build()", "System + turn prompt"),
        ("4. Get History", TEAL, "contextManager.get()", "Sliding window msgs"),
    ]

    steps_r2 = [
        ("5. LLM Call", PURPLE, "provider.chooseAction()", "Send to LLM API"),
        ("6. Execute", AMBER, "adapter.step(action)", "Apply action to game"),
        ("7. Record", GREEN, "traceWriter.writeStep()", "JSONL + SSE event"),
        ("8. Check Done", RED, "adapter.isDone()", "WIN / maxSteps / skips"),
    ]

    # Draw Row 1 (left to right)
    for i, (label, color, code, desc) in enumerate(steps_r1):
        x = row1_x + i * (step_w + gap_x)
        y = row1_y - step_h
        draw_box(c, x, y, step_w, step_h, label, accent=color, sublabel=code)
        c.setFillColor(DIM)
        c.setFont(font("InstrumentSans"), 7)
        c.drawString(x + 12, y + 6, desc)
        if i < 3:
            draw_arrow_right(c, x + step_w, x + step_w + gap_x, y + step_h / 2, color=color)

    # Arrow from row 1 down to row 2
    r1_last_x = row1_x + 3 * (step_w + gap_x) + step_w / 2
    r2_top_y = row1_y - step_h - gap_y
    draw_arrow_down(c, r1_last_x, row1_y - step_h, r2_top_y + step_h, color=PURPLE)

    # Draw Row 2 (right to left visually, but we draw left to right with reversed data)
    for i, (label, color, code, desc) in enumerate(reversed(steps_r2)):
        x = row1_x + i * (step_w + gap_x)
        y = r2_top_y
        draw_box(c, x, y, step_w, step_h, label, accent=color, sublabel=code)
        c.setFillColor(DIM)
        c.setFont(font("InstrumentSans"), 7)
        c.drawString(x + 12, y + 6, desc)

    # Arrows for row 2 (right to left)
    for i in range(3):
        x_right = row1_x + (3 - i) * (step_w + gap_x)
        x_left = x_right - gap_x
        y = r2_top_y + step_h / 2
        draw_arrow_right(c, x_left + step_w, x_right, y, color=DIM)

    # Loop-back arrow annotation
    loop_y = r2_top_y - 30
    c.setFillColor(RED)
    c.setFont(font("InstrumentSans-Bold"), 9)
    c.drawString(row1_x + 10, loop_y, "if !done && step < maxSteps")
    c.setFillColor(DIM)
    c.setFont(font("InstrumentSans"), 8)
    c.drawString(row1_x + 200, loop_y, "-> loop back to step 2 (Observe)")

    # Step detail code block
    code_block(c, MARGIN + 20, loop_y - 20, 710, [
        "// One step of the evaluation loop",
        "const obs = adapter.renderText();           // \"  0 1 2 3\\n 0 . R . .\\n 1 . . G .\"",
        "const img = await adapter.renderPngBase64(); // base64 PNG screenshot for vision models",
        "const prompt = promptBuilder.buildTurnPrompt({ step, maxSteps, obs, actions, notepad });",
        "const history = contextManager.getMessages(); // sliding window of past turns",
        "const response = await provider.chooseAction(systemPrompt, history, prompt, actions, notepad, img);",
        "await adapter.step(response.action);         // ACTION1, ACTION2, CLICK x y, RESET, etc.",
        "contextManager.addTurn(prompt, response);     // grows the window",
        "notepad.update(response.notepadUpdate);       // persistent agent memory",
        "traceWriter.writeStep({ step, action, score, cost, reasoning, observation });",
        "// emit SSE: { type: 'eval.step', step, action, score, cost_usd }",
    ], title="Step Implementation")


# ═══════════════════════════════════════════════════════
# PAGE 4: GAME ADAPTER + PYTHON BRIDGE
# ═══════════════════════════════════════════════════════

def page_adapters(c):
    fill_bg(c)
    draw_grid_dots(c)
    draw_header(c, "Game Adapter  +  Python Bridge", 4)
    draw_footer(c)

    # Two columns: TypeScript (left) and Python (right)
    col_w = 340
    col1_x = MARGIN + 15
    col2_x = PAGE_W / 2 + 20

    # Column headers
    y_top = CONTENT_TOP - 15
    nx = badge(c, col1_x, y_top, "TypeScript", TEAL)
    badge(c, nx + 4, y_top, "arc3GameAdapter.ts", DIM)

    nx2 = badge(c, col2_x, y_top, "Python", AMBER)
    badge(c, nx2 + 4, y_top, "arcengine (pip)", DIM)

    # GameAdapter interface
    code_block(c, col1_x, y_top - 20, col_w, [
        "interface GameAdapter {",
        "  readonly gameId: string;",
        "  readonly gameType: 'ARC3' | 'ARC2';",
        "  reset(): Promise<void>;",
        "  step(action: string): Promise<void>;",
        "  getScore(): number;       // 0.0 - 1.0",
        "  getState(): GameState;",
        "  isDone(): boolean;",
        "  getAvailableActions(): string[];",
        "  renderText(): string;",
        "  renderPngBase64(): Promise<string|null>;",
        "}",
    ], title="GameAdapter Interface")

    # Python side
    code_block(c, col2_x, y_top - 20, col_w, [
        "# arcengine pip package",
        "from arcengine.games.official.ct01 import CT01",
        "",
        "game = CT01()",
        "game.reset()",
        "obs = game.render()    # text grid",
        "game.step('ACTION1')   # UP",
        "score = game.score()   # levels/total",
        "state = game.state()   # IN_PROGRESS|WIN",
        "",
        "# 9 known games:",
        "# ct01 ct03 ft09 gw01 gw02 ls20 vc33 ws03 ws04",
    ], title="Python Game Engine")

    # JSONL Protocol in the middle-bottom
    proto_y = y_top - 225
    c.setFillColor(WHITE)
    c.setFont(font("InstrumentSans-Bold"), 10)
    c.drawString(col1_x, proto_y, "JSONL-over-stdio Protocol")

    code_block(c, col1_x, proto_y - 15, PAGE_W - MARGIN * 2 - 30, [
        '// TypeScript -> Python (stdin)              // Python -> TypeScript (stdout)',
        '{"command":"init","game_id":"ct01"}           {"status":"ok","game_id":"ct01","state":{...}}',
        '{"command":"reset"}                           {"status":"ok","score":0,"state":"IN_PROGRESS"}',
        '{"command":"step","action":"ACTION1"}          {"status":"ok","score":0.33,"state":"IN_PROGRESS","obs":"..."}',
        '{"command":"render_png"}                       {"status":"ok","image_b64":"iVBOR..."}',
        '{"command":"quit"}                             (process exits)',
    ], title="gameBridge.ts  <->  Python subprocess")

    # Action mapping
    map_y = proto_y - 130
    c.setFillColor(WHITE)
    c.setFont(font("InstrumentSans-Bold"), 10)
    c.drawString(col1_x, map_y, "Action Mapping")

    actions = [
        ("UP", "ACTION1"), ("DOWN", "ACTION2"), ("LEFT", "ACTION3"), ("RIGHT", "ACTION4"),
        ("SELECT", "ACTION5"), ("CLICK x y", "CLICK x y"), ("RESET", "RESET"),
    ]
    ax = col1_x
    ay = map_y - 20
    for human, engine in actions:
        c.setFillColor(WHITE)
        c.setFont(font("JetBrainsMono"), 7)
        c.drawString(ax, ay, f"{human}")
        c.setFillColor(TEAL)
        c.drawString(ax + 60, ay, f"-> {engine}")
        ax += 110
        if ax > PAGE_W - 150:
            ax = col1_x
            ay -= 15

    # Key insight
    ky = ay - 25
    rounded_rect(c, col1_x - 5, ky - 8, 500, 22, r=4, fill_color=Color(0.9, 0.2, 0.2, 0.1))
    c.setFillColor(RED)
    c.setFont(font("InstrumentSans-Bold"), 8)
    c.drawString(col1_x + 5, ky, "GAME_OVER is NOT terminal for ARC3!")
    c.setFillColor(DIM)
    c.setFont(font("InstrumentSans"), 8)
    c.drawString(col1_x + 235, ky, "Agent can RESET to retry the level.  Score = levels_completed / total_levels")


# ═══════════════════════════════════════════════════════
# PAGE 5: PROVIDERS
# ═══════════════════════════════════════════════════════

def page_providers(c):
    fill_bg(c)
    draw_grid_dots(c)
    draw_header(c, "LLM Providers  —  10 Implementations", 5)
    draw_footer(c)

    # BaseProvider interface
    code_block(c, MARGIN + 15, CONTENT_TOP - 15, 350, [
        "abstract class BaseProvider {",
        "  abstract readonly modelName: string;",
        "  abstract chooseActionAsync(",
        "    params: {",
        "      systemPrompt: string,",
        "      conversationHistory: ProviderMessage[],",
        "      currentObservation: string,",
        "      validActions: string[],",
        "      notepad: Notepad,",
        "      imageB64?: string | null,",
        "    },",
        "    signal?: AbortSignal",
        "  ): Promise<ProviderResponse>;",
        "}",
    ], title="shared/providers/base.ts")

    # ProviderResponse
    code_block(c, PAGE_W / 2 + 20, CONTENT_TOP - 15, 340, [
        "interface ProviderResponse {",
        "  action: string;           // 'UP', 'CLICK 5 3'",
        "  reasoning: string;        // chain-of-thought",
        "  notepadUpdate?: string;   // persistent memory",
        "  inputTokens: number;",
        "  outputTokens: number;",
        "  reasoningTokens: number;  // for o3, etc.",
        "  costUsd: number;",
        "  cachedInputTokens: number;",
        "  cacheWriteTokens: number;",
        "}",
    ], title="ProviderResponse")

    # Provider grid
    providers = [
        ("OpenAI GPT-5.4", "Responses API", "/v1/responses", BLUE),
        ("Gemini 3.1", "GenAI SDK", "@google/generative-ai", TEAL),
        ("GeminiFallback", "Multi-tier", "priority->standard->OR", TEAL),
        ("OpenRouter Gemini", "OpenRouter", "OpenAI-compatible", TEAL),
        ("Anthropic Claude 4.6", "Native SDK", "@anthropic-ai/sdk", PURPLE),
        ("Bedrock Claude 4.6", "Converse API", "AWS SDK", PURPLE),
        ("Bedrock Kimi K2.5", "InvokeModel", "NOT Converse (vision)", AMBER),
        ("Kimi K2.5", "Moonshot API", "Native client", AMBER),
        ("LiteLLM", "Proxy", "Universal adapter", DIM),
        ("LiteLLM SDK", "SDK", "SDK-based variant", DIM),
    ]

    grid_y = CONTENT_TOP - 225
    grid_x = MARGIN + 15
    col_w = 175
    row_h = 22
    cols = 4

    c.setFillColor(WHITE)
    c.setFont(font("InstrumentSans-Bold"), 10)
    c.drawString(grid_x, grid_y + 10, "Provider Registry  (25 models in MODEL_REGISTRY)")

    for i, (name, api, note, color) in enumerate(providers):
        col = i % cols
        row = i // cols
        x = grid_x + col * (col_w + 8)
        y = grid_y - 15 - row * (row_h + 10)

        draw_box(c, x, y, col_w, row_h, name, accent=color)
        c.setFillColor(DIM)
        c.setFont(font("JetBrainsMono"), 5.5)
        c.drawString(x + 12, y + 2, f"{api}  |  {note}")

    # Parsing fallback chain
    parse_y = grid_y - 105
    c.setFillColor(WHITE)
    c.setFont(font("InstrumentSans-Bold"), 10)
    c.drawString(grid_x, parse_y, "Response Parsing Fallback Chain")

    steps = [
        ("1. JSON Extract", "Brace-depth parsing", GREEN),
        ("2. Keyword Scan", "Case-insensitive action match", AMBER),
        ("3. Prefix Match", "Compound: 'CLICK 10 15'", TEAL),
        ("4. SKIP", "Default fallback", RED),
    ]
    sx = grid_x
    for label, desc, color in steps:
        w = 155
        by = parse_y - 25
        draw_box(c, sx, by, w, 30, label, accent=color, sublabel=desc)
        sx += w + 8
        if sx < grid_x + 4 * (w + 8) - w:
            draw_arrow_right(c, sx - 8, sx, by + 15, color=DIM)


# ═══════════════════════════════════════════════════════
# PAGE 6: CONTEXT MANAGEMENT
# ═══════════════════════════════════════════════════════

def page_context(c):
    fill_bg(c)
    draw_grid_dots(c)
    draw_header(c, "Context Management  +  Prompt Building", 6)
    draw_footer(c)

    # Three components side by side
    col_w = 225
    gap = 15

    # Context Manager
    cx = MARGIN + 15
    code_block(c, cx, CONTENT_TOP - 15, col_w, [
        "// contextManager.ts (119 lines)",
        "",
        "Window: 10 turns (20 messages)",
        "Token budget: 90% of model max",
        "Estimation: 1.2 chars = 1 token",
        "",
        "// Drops oldest turn PAIRS",
        "// Never orphans user from reply",
        "",
        "addTurn(prompt, response)",
        "getMessages() -> ProviderMessage[]",
        "trimToFit(maxTokens)",
    ], title="Context Manager")

    # Notepad
    cx2 = cx + col_w + gap
    code_block(c, cx2, CONTENT_TOP - 15, col_w, [
        "// notepad.ts (60 lines)",
        "",
        "Persistent text: 4000 char max",
        "Survives context window trimming",
        "Agent updates each step",
        "",
        "// Included in every turn prompt",
        "// when non-empty",
        "",
        "update(text: string)",
        "getText() -> string",
        "getHistory() -> string[]",
    ], title="Notepad (Agent Memory)")

    # Prompt Builder
    cx3 = cx2 + col_w + gap
    code_block(c, cx3, CONTENT_TOP - 15, col_w, [
        "// promptBuilder.ts (155 lines)",
        "",
        "System prompt: cached per gameType",
        "  ARC3: color grid + actions",
        "  ARC2: cursor grid building",
        "",
        "Turn prompt per step:",
        "  - Step N of M",
        "  - Observation (text grid)",
        "  - Available actions",
        "  - Notepad contents",
        "  - Required JSON format",
    ], title="Prompt Builder")

    # Example prompts
    prompt_y = CONTENT_TOP - 210

    c.setFillColor(WHITE)
    c.setFont(font("InstrumentSans-Bold"), 10)
    c.drawString(MARGIN + 15, prompt_y, "Prompt Structure")

    code_block(c, MARGIN + 15, prompt_y - 15, 350, [
        "// System Prompt (ARC3)",
        "You are an agent playing a puzzle game on a",
        "color grid. Available colors: black(0),",
        "blue(1), red(2), green(3), yellow(4), ...",
        "",
        "Available actions: UP, DOWN, LEFT, RIGHT,",
        "SELECT, CLICK <x> <y>, RESET",
        "",
        "Strategy: observe patterns, track progress",
        "in your notepad, reset if stuck.",
    ], title="System Prompt Example")

    code_block(c, PAGE_W / 2 + 20, prompt_y - 15, 340, [
        "// Turn Prompt (each step)",
        "Step 12 of 30",
        "",
        "Current game state:",
        "  0 1 2 3 4 5",
        " 0 . . . . . .",
        " 1 . R . . G .",
        " 2 . . . B . .",
        "Score: 1/3 levels",
        "",
        "Respond as JSON: {action, reasoning, notepad}",
    ], title="Turn Prompt Example")

    # Expected response format
    resp_y = prompt_y - 210
    code_block(c, MARGIN + 15, resp_y, 710, [
        '// Expected LLM Response JSON',
        '{ "action": "RIGHT", "reasoning": "Moving right to align with the green target...", "notepad": "Level 2: target at (4,1)" }',
    ], title="LLM Response Format")


# ═══════════════════════════════════════════════════════
# PAGE 7: DATA FLOW (API + SSE + FRONTEND)
# ═══════════════════════════════════════════════════════

def page_dataflow(c):
    fill_bg(c)
    draw_grid_dots(c)
    draw_header(c, "API  +  SSE Streaming  +  Frontend", 7)
    draw_footer(c)

    # Three-column flow: Backend -> SSE -> Frontend
    y_top = CONTENT_TOP - 20

    # API Routes
    code_block(c, MARGIN + 15, y_top, 230, [
        "// evalController.ts",
        "",
        "POST /api/eval/start",
        "  -> { sessionId }",
        "",
        "GET  /api/eval/stream/:id",
        "  -> SSE stream",
        "",
        "GET  /api/eval/sessions",
        "GET  /api/eval/runs",
        "GET  /api/eval/runs/:id/steps",
        "POST /api/eval/cancel/:id",
        "GET  /api/eval/games",
        "GET  /api/eval/models",
    ], title="Express Routes")

    # SSE Events
    sse_x = MARGIN + 270
    code_block(c, sse_x, y_top, 240, [
        "// SSE Event Types (eval.*)",
        "",
        "session_start {session_id, config}",
        "run_start     {run_id, model, game}",
        "step          {run_id, step, action,",
        "               score, cost_usd}",
        "run_end       {run_id, final_score,",
        "               total_cost, outcome}",
        "model_done    {model, avg_score}",
        "session_end   {session_id, summary}",
        "error         {message, context}",
        "log           {level, message}",
        "",
        "Field naming: snake_case",
    ], title="SSE Events")

    # Frontend components
    fe_x = MARGIN + 535
    code_block(c, fe_x, y_top, 215, [
        "// Frontend Pages",
        "",
        "PuzzleEvalDashboard.tsx",
        "  - Start eval form",
        "  - Model progress cards",
        "  - Score charts (Recharts)",
        "  - Run history table",
        "",
        "TrajectoryViewer.tsx",
        "  - Step-by-step replay",
        "  - Action + reasoning",
        "  - Observation at each step",
        "  - Notepad history",
    ], title="React Components")

    # Arrows between columns
    arrow_y = y_top - 90
    draw_arrow_right(c, MARGIN + 245, sse_x, arrow_y, color=BLUE, label="emit events")
    draw_arrow_right(c, sse_x + 240, fe_x, arrow_y, color=PURPLE, label="useEvalProgress()")

    # Database layer
    db_y = y_top - 265
    c.setFillColor(WHITE)
    c.setFont(font("InstrumentSans-Bold"), 10)
    c.drawString(MARGIN + 15, db_y, "Database  —  EvalRepository.ts")

    code_block(c, MARGIN + 15, db_y - 15, 350, [
        "// 3 tables + in-memory fallback",
        "",
        "eval_sessions  -> session config + metadata",
        "eval_runs      -> per model x game x run",
        "eval_steps     -> per step within a run",
        "",
        "// Works WITHOUT PostgreSQL (in-memory)",
        "// DB = historical, SSE = live",
        "// Frontend merges both for charts",
    ], title="Database Layer")

    # Hooks
    code_block(c, PAGE_W / 2 + 20, db_y - 15, 340, [
        "// React Hooks (TanStack Query)",
        "",
        "useEvalProgress(sessionId)  // SSE streaming",
        "useEvalSessions()           // list sessions",
        "useEvalRuns(sessionId)      // list runs",
        "useEvalSteps(runId)         // step details",
        "useEvalGames()              // available games",
        "useEvalModels()             // available models",
        "useStartEval()              // mutation",
        "useCancelEval()             // mutation",
    ], title="React Hooks")


# ═══════════════════════════════════════════════════════
# PAGE 8: TRACE OUTPUT + FILE MAP
# ═══════════════════════════════════════════════════════

def page_traces(c):
    fill_bg(c)
    draw_grid_dots(c)
    draw_header(c, "Trace Writing  +  File Map", 8)
    draw_footer(c)

    y_top = CONTENT_TOP - 15

    # Trace structure
    code_block(c, MARGIN + 15, y_top, 350, [
        "// traceWriter.ts  (306 lines)",
        "",
        "Output path:",
        "data/puzzle-evals/{timestamp}/{gameId}/",
        "  traces/{modelName}_run{N}.jsonl",
        "",
        "Record types:",
        '  header  {"type":"header","config":...}',
        '  step    {"type":"step","step":1,',
        '           "action":"RIGHT","score":0.33,',
        '           "cost":0.002,"reasoning":"..."}',
        '  summary {"type":"summary","finalScore":1.0,',
        '           "totalCost":0.42,"steps":29}',
        '  skip    {"type":"skip","reason":"..."}',
    ], title="JSONL Trace Writer")

    # File map
    code_block(c, PAGE_W / 2 + 20, y_top, 340, [
        "server/services/eval/",
        "  runner/",
        "    index.ts           <- ENTRYPOINT",
        "    evalRunner.ts      <- THE HEART",
        "    contextManager.ts  <- Sliding window",
        "    notepad.ts         <- Agent memory",
        "    promptBuilder.ts   <- Prompt templates",
        "  adapters/",
        "    types.ts           <- GameAdapter iface",
        "    arc3GameAdapter.ts <- ARC3 wrapper",
        "    gameBridge.ts      <- Python subprocess",
        "  data/",
        "    traceWriter.ts     <- JSONL output",
        "  validation/",
        "    gameValidator.ts   <- Pre-run checks",
        "  evalOrchestrator.ts  <- THE BRAIN",
    ], title="File Map")

    # Provider + config file map
    map_y = y_top - 250
    code_block(c, MARGIN + 15, map_y, 350, [
        "shared/",
        "  providers/",
        "    base.ts              <- BaseProvider",
        "    pricing.ts           <- Token pricing",
        "    openaiProvider.ts    <- GPT-5.4",
        "    geminiProvider.ts    <- Gemini 3.1",
        "    anthropicClaudeProvider.ts",
        "    bedrockClaudeProvider.ts",
        "    bedrockKimiProvider.ts",
        "    kimiProvider.ts",
        "    openrouterGeminiProvider.ts",
        "    geminiFallbackProvider.ts",
        "    litellmProvider.ts",
        "  config/",
        "    llmConfig.ts         <- MODEL_REGISTRY",
    ], title="Provider + Config Files")

    # API + Frontend map
    code_block(c, PAGE_W / 2 + 20, map_y, 340, [
        "server/",
        "  services/evalService.ts    <- HTTP service",
        "  controllers/evalController.ts <- Routes+SSE",
        "  repositories/EvalRepository.ts <- DB layer",
        "",
        "client/src/",
        "  pages/",
        "    PuzzleEvalDashboard.tsx  <- Main UI",
        "    TrajectoryViewer.tsx     <- Step replay",
        "  components/puzzle-eval/",
        "    ScoreOverStepsChart.tsx",
        "    ScoreVsCostChart.tsx",
        "  hooks/",
        "    useEvalProgress.ts      <- SSE hook",
        "    useEvalRuns.ts          <- Query hooks",
    ], title="API + Frontend Files")


# ═══════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════

def main():
    register_fonts()

    output_path = os.path.join(os.path.dirname(__file__), "docs", "eval-architecture.pdf")
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    c = canvas.Canvas(output_path, pagesize=(PAGE_W, PAGE_H))

    pages = [
        page_title,
        page_architecture,
        page_step_loop,
        page_adapters,
        page_providers,
        page_context,
        page_dataflow,
        page_traces,
    ]

    for i, page_fn in enumerate(pages):
        page_fn(c)
        if i < len(pages) - 1:
            c.showPage()

    c.save()
    print(f"Generated: {output_path}")
    print(f"Pages: {len(pages)}")

if __name__ == "__main__":
    main()

# Demo recording for the README, rendered with https://github.com/charmbracelet/vhs
#
#   npm install -g axiom-math
#   vhs docs/demo.tape
#
# The point of the recording is the first beat: d/dx(x^x) is where a language
# model reaches for the power rule and produces x*x^(x-1), which is wrong and
# looks right. Everything after that is framing.
#
# Four things learned by rendering this, each visible in an earlier take:
#
#   - Narration is plain ASCII. An em-dash inside a Type string desynchronises
#     VHS's cursor tracking and the line comes out scrambled, e.g.
#     "# d/dx(x^ a model reaches for the power rule:x)".
#   - Nothing may wrap. The width below fits the longest line here (63 columns)
#     with margin; measure any new line against that before adding it.
#   - A multi-line command output leaves the terminal desynchronised, and every
#     narration line typed after it is echoed twice — for the rest of the
#     recording, not just once. Clearing between beats is the reliable fix,
#     hence the Hide/Show blocks: a fresh screen always renders the next line
#     once.
#   - The first verify runs --method symbolic. Its numeric check prints a
#     148-character line that fits at no sane width, and the symbolic check is
#     the stronger evidence anyway: it shows the CAS simplifying the difference
#     rather than sampling points.

Output docs/demo.gif

Set Shell bash
Set FontSize 18
Set Width 1200
Set Height 300
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 32ms

Hide
Type "clear"
Enter
Show

Sleep 600ms

Type "# d/dx(x^x) - a model reaches for the power rule:"
Enter
Sleep 700ms
Type "axiom-math verify --method symbolic 'diff(x^x,x) = x*x^(x-1)'"
Sleep 400ms
Enter
Sleep 3000ms

Hide
Type "clear"
Enter
Show
Sleep 400ms

Type "# Wrong, and it looked right. The actual answer:"
Enter
Sleep 700ms
Type "axiom-math verify -q 'diff(x^x,x) = x^x*(ln(x)+1)'"
Sleep 400ms
Enter
Sleep 2000ms

Hide
Type "clear"
Enter
Show
Sleep 400ms

Type "# It computes too - exact, local, no API key:"
Enter
Sleep 700ms
Type "axiom-math compute -q 'integrate(x^2*exp(-x),x,0,inf)'"
Sleep 400ms
Enter
Sleep 2000ms

Hide
Type "clear"
Enter
Show
Sleep 400ms

Type "# The exit code is the verdict, so an agent can branch on it:"
Enter
Sleep 700ms
Type "axiom-math verify -q 'sin(x)^2+cos(x)^2 = 1' && echo holds"
Sleep 400ms
Enter
Sleep 2600ms

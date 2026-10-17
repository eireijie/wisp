# Inlines ghost-arms.css and ghost-arms.js into one standalone page: ghost-arms-preview.html
import pathlib
here = pathlib.Path(__file__).parent
html = (here / "preview.html").read_text()
html = html.replace('<link rel="stylesheet" href="ghost-arms.css" />', "<style>\n" + (here / "ghost-arms.css").read_text() + "</style>")
html = html.replace('<script src="ghost-arms.js"></script>', "<script>\n" + (here / "ghost-arms.js").read_text() + "</script>")
(here / "ghost-arms-preview.html").write_text(html)

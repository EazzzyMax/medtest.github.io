# MedikTest

Static searchable MedikTest browser for questions and 12-step clinical cases from "Лечебное дело".

## Files

- `index.html` - application shell.
- `styles.css` - layout and visual styles.
- `app.js` - search, filtering, highlighting, and virtualized rendering.
- `data.js` - bundled question data.
- `tasks.html` - clinical case browser.
- `tasks.js` - case search, topic filtering, highlighting, and expandable case rendering.
- `tasks-data.js` - bundled data for 539 clinical cases and their 6468 steps.
- `tasks.css` - clinical case layout and responsive styles.
- `CNAME` - GitHub Pages custom domain.

## Local preview

```powershell
python -m http.server 4173
```

Open `http://localhost:4173/`.

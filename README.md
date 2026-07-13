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
- `task-images/` - 1000 locally bundled tables, scans, ECGs, and other case images.
- `scripts/download_task_images.py` - repeatable image downloader for markers in `tasks-data.js`.
- `CNAME` - GitHub Pages custom domain.

## Local preview

```powershell
python -m http.server 4173
```

Open `http://localhost:4173/`.

## Refresh clinical case images

```powershell
python .\scripts\download_task_images.py
```

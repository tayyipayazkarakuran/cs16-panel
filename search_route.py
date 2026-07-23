with open('routes/servers.js', 'r', encoding='utf-8') as f:
    for i, line in enumerate(f, 1):
        if 'router.get(' in line:
            print(f"{i}: {line.strip()}")

with open('routes/servers.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()
    for i, line in enumerate(lines, 1):
        if '/:id/start' in line:
            print(f"{i}: {line.strip()}")
            for j in range(i, min(i+25, len(lines))):
                print(f"  {j+1}: {lines[j].strip()}")

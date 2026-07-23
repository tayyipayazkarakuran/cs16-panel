function parseProtectedPorts(value = process.env.PROTECTED_SERVER_PORTS || '27015,27016') {
    return new Set(String(value)
        .split(',')
        .map(port => parseInt(port.trim(), 10))
        .filter(Number.isInteger));
}

const PROTECTED_SERVER_PORTS = parseProtectedPorts();

function isProtectedPort(port) {
    return PROTECTED_SERVER_PORTS.has(parseInt(port, 10));
}

function assertDestructiveOperationAllowed(port, operation = 'modified') {
    if (!isProtectedPort(port)) return;
    const error = new Error(`Server port ${port} is protected and cannot be ${operation}`);
    error.statusCode = 409;
    throw error;
}

module.exports = {
    PROTECTED_SERVER_PORTS,
    assertDestructiveOperationAllowed,
    isProtectedPort,
    parseProtectedPorts
};

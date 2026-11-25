// Bloqueia rotas do solicitante para quem não fez login.

export function exigirSolicitante(req, res, next) {
  if (!req.session.solicitanteId) {
    return res.status(401).json({ erro: 'Faça login para continuar.' });
  }
  next();
}

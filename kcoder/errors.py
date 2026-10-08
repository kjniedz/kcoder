"""Exceptions shared between the daemon and its helper modules.

kcoderd runs as `python -m kcoder.daemon`, which loads daemon.py as
`__main__`; a helper doing `from .daemon import RequestError` would get a
second copy of the module and a *different* class, so the daemon's
`except RequestError` never matched and every refusal was logged as a
crash. Keep shared exceptions here instead.
"""


class RequestError(Exception):
    """A request the daemon refuses; the message goes back to the client as-is."""

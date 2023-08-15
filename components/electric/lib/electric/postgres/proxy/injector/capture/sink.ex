defmodule Electric.Postgres.Proxy.Injector.Capture.Sink do
  @moduledoc """
  Expects a certain stream of message types from the upstream server, set in
  `:wait`, and simply discards them.

  Once the expected sequence of messages is over the pending messages in
  `:buffer` and sent in the direction specified by `:direction` and the capture
  is over.

  `after_fun` can be set to perform some action once the sink has completed.
  """

  defstruct [:buffer, :wait, direction: :front, after_fun: nil]

  alias PgProtocol.Message, as: M
  alias Electric.Postgres.Proxy.Injector.{Capture, Send, State}

  @type after_fun :: (State.t(), Send.t() -> {Capture.t(), State.t(), Send.t()})
  @type t() :: %__MODULE__{
          buffer: [M.t()],
          wait: [module()],
          direction: :front | :back,
          after_fun: nil | after_fun()
        }

  defimpl Electric.Postgres.Proxy.Injector.Capture do
    def recv_frontend(_m, _msg, _state, _send) do
      raise "shouldn't get a frontend message while sinking responses from backend"
    end

    def recv_backend(_sink, %M.ErrorResponse{} = msg, state, send) do
      {nil, state, Send.front(send, msg)}
    end

    def recv_backend(sink, %M.NoticeResponse{} = msg, state, send) do
      {sink, state, Send.front(send, msg)}
    end

    # we're done - send the buffer to the front/backend
    def recv_backend(%{wait: [t]} = sink, %t{} = _msg, state, send) do
      send =
        apply(Send, sink.direction, [send, Enum.reverse(sink.buffer)])

      if is_function(sink.after_fun, 2) do
        sink.after_fun.(state, send)
      else
        {nil, state, send}
      end
    end

    def recv_backend(%{wait: [t | rest]} = sink, %t{} = _msg, state, send) do
      {%{sink | wait: rest}, state, send}
    end
  end
end

from app import chat


def test_chat():
    assert chat("hi", model="gpt-fixture-retired")
